import { describe, expect, it } from "vitest";

import { InMemoryDynamoDocument } from "../aws/inMemoryDynamoDocument";
import { DynamoVoiceSessionStore } from "./aws/DynamoVoiceSessionStore";
import {
  ConnectContactDisabledError,
  DisabledConnectWebRtcContactPort,
  MalformedConnectResponseError,
  parseConnectWebRtcResponse,
  VoiceSessionService,
  InMemoryVoiceRateLimiter,
  InMemoryVoiceSessionStore,
  type ConnectWebRtcContactPort,
  type StoredVoiceGrant,
  type VoiceRateLimiter,
  type VoiceSessionStore,
} from "./index";

const NOW = new Date("2026-09-04T09:00:00.000Z");
const SESSION_EXPIRES = "2026-09-04T09:30:00.000Z";

/** A realistic StartWebRTCContact response, plus fields we must not forward. */
function connectResponse(overrides: Record<string, unknown> = {}) {
  return {
    ContactId: "contact-1",
    ParticipantId: "participant-1",
    ParticipantToken: "participant-token-1",
    ConnectionData: {
      Attendee: {
        AttendeeId: "attendee-1",
        JoinToken: "join-token-1",
      },
      Meeting: {
        MeetingId: "meeting-1",
        MediaRegion: "eu-central-1",
        MediaPlacement: { AudioHostUrl: "https://example.invalid/audio" },
      },
    },
    $metadata: { httpStatusCode: 200, requestId: "req-1" },
    ...overrides,
  };
}

function contactsReturning(raw: unknown): ConnectWebRtcContactPort {
  return {
    enabled: true,
    async startWebRtcContact() {
      return raw;
    },
  };
}

function service(
  overrides: {
    enabled?: boolean;
    contacts?: ConnectWebRtcContactPort;
    store?: VoiceSessionStore;
    rateLimiter?: VoiceRateLimiter;
    grantLifetimeSeconds?: number;
  } = {},
) {
  return new VoiceSessionService({
    enabled: overrides.enabled ?? true,
    contacts: overrides.contacts ?? contactsReturning(connectResponse()),
    store: overrides.store ?? new InMemoryVoiceSessionStore(),
    rateLimiter: overrides.rateLimiter ?? new InMemoryVoiceRateLimiter(),
    grantLifetimeSeconds: overrides.grantLifetimeSeconds,
  });
}

const command = {
  judgeId: "judge-1",
  sessionId: "session-0001",
  missionId: "MISSION-SSD-20",
  procurementSessionExpiresAt: SESSION_EXPIRES,
  now: NOW,
};

describe("Connect response parsing", () => {
  it("projects only the fields the browser needs", () => {
    const parsed = parseConnectWebRtcResponse(connectResponse());

    expect(parsed).toEqual({
      contactId: "contact-1",
      participantId: "participant-1",
      participantToken: "participant-token-1",
      meetingId: "meeting-1",
      attendeeId: "attendee-1",
      attendeeJoinToken: "join-token-1",
      mediaRegion: "eu-central-1",
    });
    // SDK metadata and unused nested structures are dropped, not forwarded.
    expect(Object.keys(parsed)).not.toContain("$metadata");
    expect(JSON.stringify(parsed)).not.toContain("MediaPlacement");
  });

  it("fails closed on every missing or malformed field", () => {
    const cases: Array<[string, unknown]> = [
      ["response", null],
      ["response", "a string"],
      ["ContactId", connectResponse({ ContactId: undefined })],
      ["ParticipantToken", connectResponse({ ParticipantToken: "" })],
      ["ConnectionData", connectResponse({ ConnectionData: undefined })],
      ["ConnectionData.Attendee", connectResponse({ ConnectionData: { Meeting: {} } })],
    ];

    for (const [, raw] of cases) {
      expect(() => parseConnectWebRtcResponse(raw)).toThrow(MalformedConnectResponseError);
    }
  });
});

describe("protected voice session contract", () => {
  it("starts a session and returns only a projected grant", async () => {
    const result = await service().start(command);

    expect(result.status).toBe("STARTED");
    if (result.status !== "STARTED") throw new Error("expected a grant");
    expect(result.grant.singleUse).toBe(true);
    expect(result.grant.expiresAt).toBe("2026-09-04T09:02:00.000Z");
    expect(Object.keys(result.grant.joinInformation).sort()).toEqual([
      "attendeeId",
      "attendeeJoinToken",
      "mediaRegion",
      "meetingId",
    ]);
    // The raw Connect response never reaches the browser.
    expect(JSON.stringify(result.grant)).not.toContain("$metadata");
    expect(JSON.stringify(result.grant)).not.toContain("contact-1");
  });

  it("refuses when WebRTC Judge Mode is disabled", async () => {
    const result = await service({ enabled: false }).start(command);

    expect(result).toMatchObject({ status: "REFUSED", reason: "DISABLED" });
  });

  it("refuses when only the shipped disabled contact port is available", async () => {
    const result = await service({
      contacts: new DisabledConnectWebRtcContactPort(),
    }).start(command);

    expect(result).toMatchObject({ status: "REFUSED", reason: "DISABLED" });
  });

  it("refuses without an authenticated judge identity", async () => {
    for (const judgeId of ["", "   "]) {
      const result = await service().start({ ...command, judgeId });
      expect(result).toMatchObject({ status: "REFUSED", reason: "IDENTITY_MISSING" });
    }
  });

  it("refuses once the procurement session has expired", async () => {
    const result = await service().start({
      ...command,
      procurementSessionExpiresAt: "2026-09-04T08:59:59.000Z",
    });

    expect(result).toMatchObject({ status: "REFUSED", reason: "SESSION_EXPIRED" });
  });

  it("refuses a judge who exceeds the per-judge ceiling", async () => {
    const rateLimiter = new InMemoryVoiceRateLimiter(2);
    const voice = service({ rateLimiter });

    await voice.start({ ...command, sessionId: "session-a" });
    await voice.start({ ...command, sessionId: "session-b" });
    const third = await voice.start({ ...command, sessionId: "session-c" });

    expect(third).toMatchObject({ status: "REFUSED", reason: "RATE_LIMITED" });
  });

  it("does not call Connect when the caller is already throttled", async () => {
    let calls = 0;
    const contacts: ConnectWebRtcContactPort = {
      enabled: true,
      async startWebRtcContact() {
        calls += 1;
        return connectResponse();
      },
    };
    const voice = service({ contacts, rateLimiter: new InMemoryVoiceRateLimiter(1) });

    await voice.start({ ...command, sessionId: "session-a" });
    await voice.start({ ...command, sessionId: "session-b" });

    expect(calls).toBe(1);
  });

  it("issues at most one grant per procurement session", async () => {
    const voice = service();

    const first = await voice.start(command);
    const second = await voice.start(command);

    expect(first.status).toBe("STARTED");
    expect(second).toMatchObject({ status: "REFUSED", reason: "GRANT_ALREADY_ISSUED" });
    if (second.status !== "REFUSED") throw new Error("expected a refusal");
    // Never re-issues join material: that would make a single-use grant replayable.
    expect(JSON.stringify(second)).not.toContain("join-token-1");
  });

  it("refuses a malformed Connect response instead of building a partial grant", async () => {
    const result = await service({
      contacts: contactsReturning({ ContactId: "contact-1" }),
    }).start(command);

    expect(result).toMatchObject({ status: "REFUSED", reason: "UPSTREAM_MALFORMED" });
  });

  it("refuses when Connect itself fails", async () => {
    const result = await service({
      contacts: {
        enabled: true,
        async startWebRtcContact() {
          throw new Error("ThrottlingException");
        },
      },
    }).start(command);

    expect(result).toMatchObject({ status: "REFUSED", reason: "UPSTREAM_UNAVAILABLE" });
  });

  it("clamps a grant lifetime that exceeds the declared ceiling", async () => {
    const result = await service({ grantLifetimeSeconds: 86_400 }).start(command);

    expect(result.status).toBe("STARTED");
    if (result.status !== "STARTED") throw new Error("expected a grant");
    expect(result.grant.expiresAt).toBe("2026-09-04T09:02:00.000Z");
  });

  it("rejects a nonsensical grant lifetime at construction", () => {
    expect(() => service({ grantLifetimeSeconds: 0 })).toThrow();
    expect(() => service({ grantLifetimeSeconds: -1 })).toThrow();
  });

  it("names the refused session when the disabled port throws", async () => {
    const port = new DisabledConnectWebRtcContactPort();

    await expect(
      port.startWebRtcContact({ sessionId: "session-9", missionId: "m", judgeId: "j" }),
    ).rejects.toBeInstanceOf(ConnectContactDisabledError);
  });
});

const voiceStores: Array<[string, () => VoiceSessionStore]> = [
  ["InMemoryVoiceSessionStore", () => new InMemoryVoiceSessionStore()],
  [
    "DynamoVoiceSessionStore",
    () => new DynamoVoiceSessionStore(new InMemoryDynamoDocument(), "stockguard-procurement"),
  ],
];

describe.each(voiceStores)("%s", (_name, build) => {
  const grant: StoredVoiceGrant = {
    sessionId: "session-0001",
    judgeId: "judge-1",
    contactId: "contact-1",
    issuedAt: NOW.toISOString(),
    expiresAt: "2026-09-04T09:02:00.000Z",
    consumedAt: null,
  };

  it("claims a grant once per session", async () => {
    const store = build();

    expect((await store.claimGrant(grant)).kind).toBe("CLAIMED");
    expect((await store.claimGrant({ ...grant, contactId: "contact-2" })).kind).toBe(
      "ALREADY_ISSUED",
    );
  });

  it("keeps concurrent claims to a single winner", async () => {
    const store = build();

    const results = await Promise.all([
      store.claimGrant(grant),
      store.claimGrant({ ...grant, contactId: "contact-2" }),
      store.claimGrant({ ...grant, contactId: "contact-3" }),
    ]);

    expect(results.filter((result) => result.kind === "CLAIMED")).toHaveLength(1);
  });

  it("records consumption and treats a second consume as a no-op", async () => {
    const store = build();
    await store.claimGrant(grant);

    await store.markConsumed("session-0001", "2026-09-04T09:00:30.000Z");
    await store.markConsumed("session-0001", "2026-09-04T09:01:30.000Z");

    expect((await store.get("session-0001"))?.consumedAt).toBe("2026-09-04T09:00:30.000Z");
  });

  it("returns null for an unknown session", async () => {
    expect(await build().get("session-missing")).toBeNull();
  });
});
