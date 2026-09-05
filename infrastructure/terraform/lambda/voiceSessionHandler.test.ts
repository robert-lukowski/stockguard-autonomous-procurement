import { describe, expect, it } from "vitest";

import { judgeIdFrom, readStartRequest } from "./voiceSessionHandler";

/**
 * Security boundary of the only endpoint that can start a billable contact.
 *
 * Two properties, and nothing else is tested here:
 *
 *   1. identity comes from the authorizer and NOWHERE else. A caller who could
 *      name their own judge id could also reset their own rate limit.
 *   2. the body may carry exactly ONE field, shape-checked, so nothing the
 *      caller sends can widen what the request means. The procurement run is
 *      created server-side, so a caller cannot name a session id either.
 */

describe("judge identity comes only from the authorizer", () => {
  it("reads a JWT authorizer subject", () => {
    expect(
      judgeIdFrom({
        requestContext: { authorizer: { jwt: { claims: { sub: "judge-1" } } } },
      }),
    ).toBe("judge-1");
  });

  it("reads a Lambda authorizer judgeId", () => {
    expect(
      judgeIdFrom({
        requestContext: { authorizer: { lambda: { judgeId: "judge-2" } } },
      }),
    ).toBe("judge-2");
  });

  it("ignores a judgeId or sessionId supplied in the request body", () => {
    const event = {
      body: JSON.stringify({
        missionId: "MISSION-SSD-20",
        judgeId: "judge-impersonated",
        sessionId: "session-someone-elses",
      }),
      requestContext: { http: { method: "POST" } },
    };

    // No authorizer context: the handler must see no identity at all.
    expect(judgeIdFrom(event)).toBe("");
    // ...and the body parser carries neither extra field forward.
    expect(readStartRequest(event)).toEqual({ missionId: "MISSION-SSD-20" });
  });

  it("treats a blank or non-string claim as no identity", () => {
    for (const claims of [{ sub: "" }, { sub: "   " }, { sub: 42 }, {}]) {
      expect(judgeIdFrom({ requestContext: { authorizer: { jwt: { claims } } } })).toBe("");
    }
    expect(judgeIdFrom({})).toBe("");
  });
});

describe("the request body accepts one field and nothing else", () => {
  it("accepts a well-formed body", () => {
    expect(
      readStartRequest({ body: JSON.stringify({ missionId: "MISSION-SSD-20" }) }),
    ).toEqual({ missionId: "MISSION-SSD-20" });
  });

  it("decodes a base64 body", () => {
    expect(
      readStartRequest({
        body: Buffer.from(JSON.stringify({ missionId: "MISSION-SSD-20" })).toString("base64"),
        isBase64Encoded: true,
      }),
    ).toEqual({ missionId: "MISSION-SSD-20" });
  });

  it("rejects anything malformed rather than defaulting", () => {
    for (const body of [
      undefined,
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({}),
      JSON.stringify({ missionId: "" }),
      JSON.stringify({ missionId: 1 }),
      // Injection-shaped values must not reach a DynamoDB key.
      JSON.stringify({ missionId: "MISSION/../other" }),
      JSON.stringify({ missionId: "PSESSION#other" }),
      JSON.stringify({ missionId: "m".repeat(100) }),
      JSON.stringify({ missionId: "mission with spaces" }),
    ]) {
      expect(readStartRequest({ body })).toBeNull();
    }
  });
});
