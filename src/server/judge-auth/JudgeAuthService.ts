import { sha256 } from "../../security";
import {
  BEARER_PREFIX,
  JUDGE_SESSION_TTL_MS,
  type AccessCodeVerification,
  type AccessCodeVerifierPort,
  type JudgeAuthSession,
  type JudgeAuthStore,
  type JudgeAuthorizeResult,
  type JudgeLoginRateLimiter,
  type JudgeLoginResult,
} from "./types";

/**
 * Exchanges an access code for a short-lived opaque session token.
 *
 * The reverse direction — token to judge identity — is `authorize`, which the
 * API Gateway Lambda authorizer calls. Nothing else in the system decides who
 * a caller is.
 */

export type JudgeAuthServiceConfig = {
  enabled: boolean;
  verifier: AccessCodeVerifierPort;
  store: JudgeAuthStore;
  rateLimiter: JudgeLoginRateLimiter;
  sessionTtlMs?: number;
  /** Injected in tests; production uses the Web Crypto RNG. */
  randomToken?: () => string;
};

/**
 * 256 bits of CSPRNG output, hex encoded.
 *
 * Deliberately not a UUID: a v4 UUID carries only 122 random bits and its
 * shape advertises what it is. This token is a bearer credential and should
 * look like nothing else.
 */
function defaultRandomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Pulls the token out of an Authorization header.
 *
 * Returns null rather than throwing, so a missing or malformed header is
 * simply "not authenticated" and never a 500 the caller could use to probe.
 */
export function bearerToken(header: string | undefined | null): string | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (!BEARER_PREFIX.test(trimmed)) return null;
  const token = trimmed.replace(BEARER_PREFIX, "").trim();
  // Fixed alphabet and length: anything else was not minted here.
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

export class JudgeAuthService {
  private readonly sessionTtlMs: number;
  private readonly randomToken: () => string;

  constructor(private readonly config: JudgeAuthServiceConfig) {
    this.sessionTtlMs = config.sessionTtlMs ?? JUDGE_SESSION_TTL_MS;
    if (!Number.isInteger(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
      throw new Error("Judge session TTL must be a positive number of milliseconds");
    }
    this.randomToken = config.randomToken ?? defaultRandomToken;
  }

  /**
   * Verifies an access code and mints a session.
   *
   * `rateLimitKey` is the caller's source IP, supplied by the API Gateway
   * request context. It is the only thing available before authentication, and
   * without it an attacker could grind the access code for free.
   */
  async login(
    accessCode: string,
    rateLimitKey: string,
    now: Date,
  ): Promise<JudgeLoginResult> {
    if (!this.config.enabled) {
      return {
        status: "REJECTED",
        reason: "DISABLED",
        message: "Judge sign-in is disabled in this deployment.",
      };
    }

    if (typeof accessCode !== "string" || accessCode.trim().length === 0) {
      return {
        status: "REJECTED",
        reason: "INVALID_ACCESS_CODE",
        message: "That access code was not accepted.",
      };
    }

    // Counted before verification, so a wrong code still costs an attempt.
    if (!(await this.config.rateLimiter.allow(rateLimitKey, now))) {
      return {
        status: "REJECTED",
        reason: "RATE_LIMITED",
        message: "Too many sign-in attempts. Try again shortly.",
      };
    }

    let verification: AccessCodeVerification;
    try {
      verification = await this.config.verifier.verify(accessCode);
    } catch {
      /*
       * A missing or malformed secret must not read as a valid code. Fail
       * closed and say nothing about why.
       */
      return {
        status: "REJECTED",
        reason: "UNAVAILABLE",
        message: "Judge sign-in is temporarily unavailable.",
      };
    }

    if (!verification.valid) {
      return {
        status: "REJECTED",
        reason: "INVALID_ACCESS_CODE",
        message: "That access code was not accepted.",
      };
    }

    const token = this.randomToken();
    const session: JudgeAuthSession = {
      // Stable per access code, so the voice-session ceiling survives a re-login.
      judgeId: verification.credentialId,
      tokenHash: await sha256(token),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
      status: "ACTIVE",
    };

    if ((await this.config.store.create(session)) === "DUPLICATE") {
      // 256 bits colliding means the RNG is broken. Refuse rather than reuse.
      return {
        status: "REJECTED",
        reason: "UNAVAILABLE",
        message: "Judge sign-in is temporarily unavailable.",
      };
    }

    // The plaintext token exists here and in the response body. Nowhere else.
    return { status: "AUTHENTICATED", token, expiresAt: session.expiresAt };
  }

  /**
   * Resolves an opaque token to a judge identity.
   *
   * Every denial is a distinct reason for logging, but the caller only ever
   * sees a 401 — distinguishing "unknown" from "expired" would tell an
   * attacker which tokens once existed.
   */
  async authorize(
    authorizationHeader: string | undefined | null,
    now: Date,
  ): Promise<JudgeAuthorizeResult> {
    if (authorizationHeader === undefined || authorizationHeader === null) {
      return { status: "DENIED", reason: "MISSING" };
    }
    const token = bearerToken(authorizationHeader);
    if (token === null) return { status: "DENIED", reason: "MALFORMED" };

    const session = await this.config.store.findByTokenHash(await sha256(token));
    if (!session) return { status: "DENIED", reason: "UNKNOWN" };
    if (session.status === "REVOKED") return { status: "DENIED", reason: "REVOKED" };
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      return { status: "DENIED", reason: "EXPIRED" };
    }

    return {
      status: "AUTHORIZED",
      judgeId: session.judgeId,
      expiresAt: session.expiresAt,
    };
  }
}

/** Per-process store, for local development and tests. Not durable. */
export class InMemoryJudgeAuthStore implements JudgeAuthStore {
  private readonly sessions = new Map<string, JudgeAuthSession>();

  async create(session: JudgeAuthSession): Promise<"CREATED" | "DUPLICATE"> {
    if (this.sessions.has(session.tokenHash)) return "DUPLICATE";
    this.sessions.set(session.tokenHash, structuredClone(session));
    return "CREATED";
  }

  async findByTokenHash(tokenHash: string): Promise<JudgeAuthSession | null> {
    const session = this.sessions.get(tokenHash);
    return session ? structuredClone(session) : null;
  }

  async revoke(tokenHash: string): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.status = "REVOKED";
  }
}
