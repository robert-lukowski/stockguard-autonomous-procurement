import { buildJudgeAuthService, optional } from "./judgeAuth";
import type { JudgeAuthService } from "../../../src/server/judge-auth";

/**
 * The judge sign-in endpoint.
 *
 * POST { accessCode } → { token, expiresAt }
 *
 * This is the one route that is reachable without a token, because it is what
 * issues them. It is also the only place the plaintext access code exists, and
 * it is never logged: the log line below records the outcome and nothing else.
 *
 * The response body is the only channel the token travels on. It is not set as
 * a cookie (the portal is on a different origin and a third-party cookie would
 * be dropped anyway), not put in a URL, and not written to any build-time
 * Pages variable.
 */

type HttpEvent = {
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: { method?: string; sourceIp?: string };
  };
};

type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function json(statusCode: number, body: unknown, origin: string): HttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A bearer token must never be cached by a browser or a proxy.
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
    },
    body: JSON.stringify(body),
  };
}

/** Accepts one field, length-bounded so a huge body cannot reach PBKDF2. */
export function readAccessCode(event: HttpEvent): string | null {
  if (typeof event.body !== "string" || event.body.length === 0) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (raw.length > 4096) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const accessCode = (parsed as Record<string, unknown>).accessCode;
  if (typeof accessCode !== "string") return null;
  const trimmed = accessCode.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

let service: JudgeAuthService | null = null;

export function createHandler(overrides: { service?: JudgeAuthService } = {}) {
  return async function judgeLoginHandler(event: HttpEvent): Promise<HttpResponse> {
    const origin = optional("ALLOWED_ORIGIN") || "null";
    if (event.requestContext?.http?.method !== "POST") {
      return json(405, { status: "REJECTED", reason: "METHOD_NOT_ALLOWED" }, origin);
    }

    const accessCode = readAccessCode(event);
    if (accessCode === null) {
      return json(
        400,
        {
          status: "REJECTED",
          reason: "INVALID_ACCESS_CODE",
          message: "That access code was not accepted.",
        },
        origin,
      );
    }

    /*
     * The source IP is the rate-limit key. API Gateway sets it from the
     * connection, so unlike a header a caller cannot choose their own bucket.
     * A missing value falls back to a shared bucket, which throttles everyone
     * rather than nobody.
     */
    const sourceIp = event.requestContext?.http?.sourceIp?.trim() || "unknown-source";

    try {
      service ??= buildJudgeAuthService();
      const result = await (overrides.service ?? service).login(
        accessCode,
        `judge-login#${sourceIp}`,
        new Date(),
      );

      // Outcome only. The access code and the minted token are never logged.
      console.log(
        JSON.stringify({
          event: "JUDGE_LOGIN",
          outcome: result.status,
          ...(result.status === "REJECTED" ? { reason: result.reason } : {}),
        }),
      );

      if (result.status === "REJECTED") {
        return json(result.reason === "RATE_LIMITED" ? 429 : 401, result, origin);
      }
      return json(200, result, origin);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "JUDGE_LOGIN_ERROR",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return json(
        503,
        {
          status: "REJECTED",
          reason: "UNAVAILABLE",
          message: "Judge sign-in is temporarily unavailable.",
        },
        origin,
      );
    }
  };
}

export const handler = createHandler();
