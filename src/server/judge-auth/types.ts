/**
 * Judge authentication for WebRTC Judge Mode.
 *
 * A hackathon judge has no identity provider and no account. What they have is
 * an access code printed on the submission. This module turns that code into a
 * short-lived opaque session token, using the PBKDF2 verifier and the
 * hashed-token pattern the Judge Mode backend already established.
 *
 * Three properties carry the security here:
 *
 *   - the access code is verified against a PBKDF2 digest in Secrets Manager.
 *     The plaintext code exists only in the request body and is never stored,
 *     logged, or written to this repository.
 *   - only the SHA-256 hash of the session token is persisted. A dump of the
 *     table yields nothing a caller could present.
 *   - `judgeId` is minted server-side at login and read back only from the
 *     authorizer context. Nothing a caller sends can influence it, so nobody
 *     can adopt another judge's rate-limit bucket.
 */

export type JudgeAuthSession = {
  /** Server-minted, opaque, per-login. Never supplied by a caller. */
  judgeId: string;
  /** SHA-256 of the opaque token. The token itself is never stored. */
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  status: "ACTIVE" | "REVOKED";
};

export interface JudgeAuthStore {
  create(session: JudgeAuthSession): Promise<"CREATED" | "DUPLICATE">;
  /** Looked up by token hash, so authorizing is a single point read. */
  findByTokenHash(tokenHash: string): Promise<JudgeAuthSession | null>;
  revoke(tokenHash: string): Promise<void>;
}

export type JudgeLoginResult =
  | {
      status: "AUTHENTICATED";
      /** Returned once, to the browser, in the response body only. */
      token: string;
      expiresAt: string;
    }
  | { status: "REJECTED"; reason: JudgeLoginRefusal; message: string };

export type JudgeLoginRefusal =
  | "DISABLED"
  | "INVALID_ACCESS_CODE"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export type JudgeAuthorizeResult =
  | { status: "AUTHORIZED"; judgeId: string; expiresAt: string }
  | { status: "DENIED"; reason: "MISSING" | "MALFORMED" | "UNKNOWN" | "EXPIRED" | "REVOKED" };

/** Same shape as the judge backend's limiter, so the Dynamo one fits unchanged. */
export interface JudgeLoginRateLimiter {
  allow(key: string, now: Date): Promise<boolean>;
}

export interface AccessCodeVerifierPort {
  verify(accessCode: string): Promise<boolean>;
}

/**
 * How long a judge stays signed in.
 *
 * Long enough to read the mission, start a voice session and finish the
 * conversation without re-entering the code; short enough that a token copied
 * out of a browser is worthless soon after the demo.
 */
export const JUDGE_SESSION_TTL_MS = 30 * 60_000;

/** Bearer prefix, matched case-insensitively as RFC 6750 requires. */
export const BEARER_PREFIX = /^bearer\s+/i;
