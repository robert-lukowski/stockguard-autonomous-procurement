import { describe, expect, it } from "vitest";

import { readVoiceSessionResponse, startVoiceSession } from "./voiceSessionClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reading a voice session response", () => {
  it("accepts a started session and keeps only the Chime join fields", () => {
    const state = readVoiceSessionResponse({
      status: "STARTED",
      grant: {
        sessionId: "session-1",
        expiresAt: "2026-09-04T09:02:00.000Z",
        participantToken: "participant-token",
        joinInformation: {
          meetingId: "meeting-1",
          mediaRegion: "eu-central-1",
          attendeeId: "attendee-1",
          attendeeJoinToken: "join-token",
          audioHostUrl: "https://audio.invalid",
          signalingUrl: "wss://signal.invalid",
          turnControlUrl: "https://turn.invalid",
          somethingElse: "ignored",
        },
      },
    });

    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected a grant");
    expect(state.expiresAt).toBe("2026-09-04T09:02:00.000Z");
    expect(Object.keys(state.grant).sort()).toEqual([
      "attendeeId",
      "attendeeJoinToken",
      "audioHostUrl",
      "mediaRegion",
      "meetingId",
      "signalingUrl",
      "turnControlUrl",
    ]);
  });

  it("maps every refusal reason to a message a judge can act on", () => {
    for (const reason of [
      "DISABLED",
      "IDENTITY_MISSING",
      "SESSION_EXPIRED",
      "RATE_LIMITED",
      "GRANT_ALREADY_ISSUED",
      "UPSTREAM_UNAVAILABLE",
      "UPSTREAM_MALFORMED",
    ]) {
      const state = readVoiceSessionResponse({ status: "REFUSED", reason });

      expect(state.status).toBe("refused");
      if (state.status !== "refused") throw new Error("expected a refusal");
      expect(state.reason).toBe(reason);
      expect(state.message.length).toBeGreaterThan(0);
    }
  });

  it("does not invent a ready state from a malformed body", () => {
    for (const body of [
      null,
      "a string",
      {},
      { status: "STARTED" },
      { status: "STARTED", grant: {} },
      { status: "STARTED", grant: { expiresAt: "x", joinInformation: {} } },
      {
        status: "STARTED",
        grant: {
          expiresAt: "x",
          // Missing the three MediaPlacement endpoints the SDK needs.
          joinInformation: {
            meetingId: "m",
            mediaRegion: "r",
            attendeeId: "a",
            attendeeJoinToken: "j",
          },
        },
      },
      { status: "SOMETHING_ELSE" },
    ]) {
      expect(readVoiceSessionResponse(body).status).not.toBe("ready");
    }
  });

  it("reports an unrecognized refusal reason without claiming to know it", () => {
    const state = readVoiceSessionResponse({ status: "REFUSED", reason: "TOTALLY_NEW" });

    expect(state).toMatchObject({ status: "refused", reason: "UNKNOWN" });
  });
});

describe("calling the protected endpoint", () => {
  it("never sends a judge identity in the request body", async () => {
    let sentBody = "";
    await startVoiceSession(
      "https://example.invalid/voice",
      "session-1",
      "MISSION-SSD-20",
      async (_input, init) => {
        sentBody = String(init?.body ?? "");
        return jsonResponse({ status: "REFUSED", reason: "DISABLED" });
      },
    );

    expect(JSON.parse(sentBody)).toEqual({
      sessionId: "session-1",
      missionId: "MISSION-SSD-20",
    });
    expect(sentBody).not.toContain("judgeId");
  });

  it("maps auth and throttling status codes without reading a body", async () => {
    const unauthorized = await startVoiceSession(
      "https://example.invalid/voice",
      "session-1",
      "MISSION-SSD-20",
      async () => new Response("nope", { status: 403 }),
    );
    const throttled = await startVoiceSession(
      "https://example.invalid/voice",
      "session-1",
      "MISSION-SSD-20",
      async () => new Response("nope", { status: 429 }),
    );

    expect(unauthorized).toMatchObject({ status: "refused", reason: "IDENTITY_MISSING" });
    expect(throttled).toMatchObject({ status: "refused", reason: "RATE_LIMITED" });
  });

  it("reports a network failure rather than throwing", async () => {
    const state = await startVoiceSession(
      "https://example.invalid/voice",
      "session-1",
      "MISSION-SSD-20",
      async () => {
        throw new Error("network down");
      },
    );

    expect(state).toMatchObject({ status: "error" });
  });

  it("reports an unparseable body rather than throwing", async () => {
    const state = await startVoiceSession(
      "https://example.invalid/voice",
      "session-1",
      "MISSION-SSD-20",
      async () => new Response("<html>gateway error</html>", { status: 200 }),
    );

    expect(state).toMatchObject({ status: "error" });
  });
});
