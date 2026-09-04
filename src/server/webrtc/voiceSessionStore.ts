/**
 * Durable state for WebRTC voice sessions.
 *
 * Two things must survive a process restart and be shared across instances,
 * because both are security controls rather than conveniences:
 *
 *   - a grant is SINGLE USE. Issuing one twice for the same procurement
 *     session would let a leaked grant be replayed into a second billable
 *     Amazon Connect contact.
 *   - the per-judge rate limit is a CEILING. A counter in process memory is not
 *     a ceiling; it is a counter that resets whenever the platform feels like
 *     it.
 *
 * The in-memory implementations below are honest about being neither, and
 * exist so local development and tests can run the same code paths.
 */

export type StoredVoiceGrant = {
  sessionId: string;
  judgeId: string;
  contactId: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type VoiceGrantClaim =
  | { kind: "CLAIMED" }
  | { kind: "ALREADY_ISSUED"; grant: StoredVoiceGrant };

export interface VoiceSessionStore {
  /** Atomic. Only the first caller for a session may receive CLAIMED. */
  claimGrant(grant: StoredVoiceGrant): Promise<VoiceGrantClaim>;
  get(sessionId: string): Promise<StoredVoiceGrant | null>;
  markConsumed(sessionId: string, consumedAt: string): Promise<void>;
}

/** Same shape as the judge backend's `SessionRateLimiter`, so the existing
 *  `DynamoFixedWindowRateLimiter` satisfies it without any adapter. */
export interface VoiceRateLimiter {
  allow(key: string, now: Date): Promise<boolean>;
}

/** Per-process. NOT a durable single-use control; see the note above. */
export class InMemoryVoiceSessionStore implements VoiceSessionStore {
  private readonly grants = new Map<string, StoredVoiceGrant>();

  async claimGrant(grant: StoredVoiceGrant): Promise<VoiceGrantClaim> {
    const existing = this.grants.get(grant.sessionId);
    if (existing) return { kind: "ALREADY_ISSUED", grant: structuredClone(existing) };
    this.grants.set(grant.sessionId, structuredClone(grant));
    return { kind: "CLAIMED" };
  }

  async get(sessionId: string): Promise<StoredVoiceGrant | null> {
    const grant = this.grants.get(sessionId);
    return grant ? structuredClone(grant) : null;
  }

  /**
   * First consume wins; a second is a no-op.
   *
   * Matches the durable store, whose update is conditional on consumedAt still
   * being unset. Overwriting would move the recorded consumption time on every
   * replay and lose when the grant was actually used.
   */
  async markConsumed(sessionId: string, consumedAt: string): Promise<void> {
    const grant = this.grants.get(sessionId);
    if (grant && grant.consumedAt === null) grant.consumedAt = consumedAt;
  }
}

/** Per-process. NOT a ceiling; see the note above. */
export class InMemoryVoiceRateLimiter implements VoiceRateLimiter {
  private readonly windows = new Map<string, number>();

  constructor(
    private readonly maximumAttempts = 3,
    private readonly windowMs = 60 * 60_000,
  ) {}

  async allow(key: string, now: Date): Promise<boolean> {
    const bucket = `${key}#${Math.floor(now.getTime() / this.windowMs)}`;
    const used = this.windows.get(bucket) ?? 0;
    if (used >= this.maximumAttempts) return false;
    this.windows.set(bucket, used + 1);
    return true;
  }
}
