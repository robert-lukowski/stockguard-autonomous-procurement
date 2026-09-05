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
  /**
   * Server-derived, stable per access code. Never supplied by a caller.
   *
   * Stable rather than per-login on purpose: the billable voice-session limiter
   * is keyed on it, so a fresh id per sign-in would hand a code holder a fresh
   * cost ceiling every time they signed in again.
   */
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

/**
 * The result of checking an access code.
 *
 * `credentialId` is what makes the per-judge rate limit mean anything. An
 * earlier version minted a fresh random judgeId per sign-in, so the ceiling was
 * per LOGIN: a code holder could sign in again the moment their three contacts
 * were spent and get a clean bucket. The identity must therefore be stable for
 * the life of the access code.
 *
 * It is derived from the stored PBKDF2 digest, never from the code itself. The
 * digest is already the secret, so a leaked identity reveals nothing, and
 * rotating the code rotates the identity — which is the correct behaviour.
 */
export type AccessCodeVerification =
  | { valid: false }
  | { valid: true; credentialId: string };

export interface AccessCodeVerifierPort {
  verify(accessCode: string): Promise<AccessCodeVerification>;
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
