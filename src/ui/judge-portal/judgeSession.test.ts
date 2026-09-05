import { beforeEach, describe, expect, it } from "vitest";

import {
  clearJudgeSession,
  judgeAuthorizationHeader,
  judgeSessionExpiry,
  readSignInResponse,
  signIn,
} from "./judgeSession";
import { startVoiceSession } from "./voiceSessionClient";

const TOKEN = "a".repeat(64);
const NOW = new Date("2026-09-05T09:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => clearJudgeSession());

describe("reading a sign-in response", () => {
  it("accepts a well-formed token", () => {
    expect(
      readSignInResponse({
        status: "AUTHENTICATED",
        token: TOKEN,
        expiresAt: "2026-09-05T09:30:00.000Z",
      }),
    ).toEqual({ status: "signed-in", expiresAt: "2026-09-05T09:30:00.000Z" });
  });

  it("never reports signed-in from a malformed body", () => {
    for (const body of [
      null,
      "a string",
      {},
      { status: "AUTHENTICATED" },
      { status: "AUTHENTICATED", token: "not-hex", expiresAt: "x" },
      { status: "AUTHENTICATED", token: TOKEN },
      { status: "SOMETHING_ELSE", token: TOKEN, expiresAt: "x" },
    ]) {
      expect(readSignInResponse(body).status).not.toBe("signed-in");
    }
  });

  it("explains each refusal in words a judge can act on", () => {
    for (const [reason, fragment] of [
      ["INVALID_ACCESS_CODE", "not accepted"],
      ["RATE_LIMITED", "Too many"],
      ["DISABLED", "disabled"],
      ["UNAVAILABLE", "unavailable"],
    ]) {
      const state = readSignInResponse({ status: "REJECTED", reason });
      expect(state.status).toBe("failed");
      if (state.status !== "failed") throw new Error("expected a failure");
      expect(state.message).toContain(fragment);
    }
  });
});

describe("the token stays in memory", () => {
  it("is captured on sign-in and never returned to the caller", async () => {
    const state = await signIn("https://example.invalid/judge-sessions", "CODE", async () =>
      jsonResponse({
        status: "AUTHENTICATED",
        token: TOKEN,
        expiresAt: "2026-09-05T09:30:00.000Z",
      }),
    );

    expect(state).toEqual({ status: "signed-in", expiresAt: "2026-09-05T09:30:00.000Z" });
    // The state a component renders carries no credential.
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(judgeAuthorizationHeader(NOW)).toBe(`Bearer ${TOKEN}`);
  });

  it("is never written to browser storage or the URL", async () => {
    await signIn("https://example.invalid/judge-sessions", "CODE", async () =>
      jsonResponse({
        status: "AUTHENTICATED",
        token: TOKEN,
        expiresAt: "2026-09-05T09:30:00.000Z",
      }),
    );

    // A bearer credential in any of these outlives the tab or leaks to logs.
    expect(globalThis.localStorage?.length ?? 0).toBe(0);
    expect(globalThis.sessionStorage?.length ?? 0).toBe(0);
    expect(globalThis.document?.cookie ?? "").toBe("");
  });

  it("stops offering an expired token and forgets it", () => {
    expect(judgeAuthorizationHeader(NOW)).toBeNull();
    expect(judgeSessionExpiry()).toBeNull();
  });

  it("is cleared on sign-out", async () => {
    await signIn("https://example.invalid/judge-sessions", "CODE", async () =>
      jsonResponse({
        status: "AUTHENTICATED",
        token: TOKEN,
        expiresAt: "2026-09-05T09:30:00.000Z",
      }),
    );
    clearJudgeSession();

    expect(judgeAuthorizationHeader(NOW)).toBeNull();
  });

  it("does not sign in on a rejected or unreachable response", async () => {
    const rejected = await signIn("https://example.invalid/judge-sessions", "WRONG", async () =>
      jsonResponse({ status: "REJECTED", reason: "INVALID_ACCESS_CODE" }, 401),
    );
    const unreachable = await signIn("https://example.invalid/judge-sessions", "CODE", async () => {
      throw new Error("network down");
    });
    const throttled = await signIn("https://example.invalid/judge-sessions", "CODE", async () =>
      new Response("nope", { status: 429 }),
    );

    expect(rejected.status).toBe("failed");
    expect(unreachable.status).toBe("failed");
    expect(throttled).toMatchObject({ status: "failed" });
    expect(judgeAuthorizationHeader(NOW)).toBeNull();
  });
});

describe("the voice endpoint is called with the token", () => {
  it("sends the bearer header and no identity in the body", async () => {
    await signIn("https://example.invalid/judge-sessions", "CODE", async () =>
      jsonResponse({
        status: "AUTHENTICATED",
        token: TOKEN,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    let sentHeaders: Record<string, string> = {};
    let sentBody = "";
    await startVoiceSession(
      "https://example.invalid/voice-sessions",
      "session-1",
      "MISSION-SSD-20",
      async (_input, init) => {
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        sentBody = String(init?.body ?? "");
        return jsonResponse({ status: "REFUSED", reason: "DISABLED" });
      },
    );

    expect(sentHeaders.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(sentBody)).toEqual({
      sessionId: "session-1",
      missionId: "MISSION-SSD-20",
    });
    expect(sentBody).not.toContain("judgeId");
    expect(sentBody).not.toContain(TOKEN);
  });

  it("refuses locally when nobody is signed in, without calling the endpoint", async () => {
    let called = false;
    const state = await startVoiceSession(
      "https://example.invalid/voice-sessions",
      "session-1",
      "MISSION-SSD-20",
      async () => {
        called = true;
        return jsonResponse({ status: "REFUSED", reason: "DISABLED" });
      },
    );

    expect(called).toBe(false);
    expect(state).toMatchObject({ status: "refused", reason: "IDENTITY_MISSING" });
  });
});
