import type {
  CallClaimInput,
  CallClaimResult,
  JudgeSessionStore,
  StoredCallClaim,
  StoredJudgeSession,
} from "./types";

export class InMemoryJudgeSessionStore implements JudgeSessionStore {
  private readonly sessions = new Map<string, StoredJudgeSession>();

  async create(session: StoredJudgeSession): Promise<void> {
    if (this.sessions.has(session.sessionId)) throw new Error("Judge session already exists");
    this.sessions.set(session.sessionId, structuredClone(session));
  }

  async getSession(sessionId: string): Promise<StoredJudgeSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async claimCall(input: CallClaimInput): Promise<CallClaimResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return { kind: "NOT_FOUND" };
    if (session.tokenHash !== input.tokenHash) return { kind: "TOKEN_INVALID" };
    if (session.status === "REVOKED") return { kind: "REVOKED" };
    if (Date.parse(session.expiresAt) <= Date.parse(input.now)) return { kind: "EXPIRED" };

    const existing = session.claims[input.idempotencyKey];
    if (existing) {
      return {
        kind: "DUPLICATE",
        session: structuredClone(session),
        claim: structuredClone(existing),
      };
    }
    if (session.status === "CONSUMED" || Object.keys(session.claims).length > 0) {
      return { kind: "CONSUMED" };
    }

    const claim: StoredCallClaim = {
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      phoneHash: input.phoneHash,
      locale: input.locale,
      consentRecordedAt: input.consentRecordedAt,
      status: "PENDING",
      callTaskId: null,
    };
    session.claims[input.idempotencyKey] = claim;
    session.status = "CONSUMED";
    return {
      kind: "CLAIMED",
      session: structuredClone(session),
      claim: structuredClone(claim),
    };
  }

  async completeClaim(
    sessionId: string,
    idempotencyKey: string,
    update: Pick<StoredCallClaim, "status" | "callTaskId">,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const claim = session?.claims[idempotencyKey];
    if (!session || !claim) throw new Error("Unknown judge call claim");
    claim.status = update.status;
    claim.callTaskId = update.callTaskId;
  }

  async revoke(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.status = "REVOKED";
  }

  getForTest(sessionId: string): StoredJudgeSession | null {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }
}
export class FixedWindowRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maximumAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  async allow(key: string, now: Date): Promise<boolean> {
    const windowStart = now.getTime() - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((time) => time > windowStart);
    if (recent.length >= this.maximumAttempts) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now.getTime());
    this.attempts.set(key, recent);
    return true;
  }
}

export class InMemoryGlobalCallBudget {
  private used = 0;

  constructor(private readonly maximumCalls: number) {}

  async claim(): Promise<boolean> {
    if (this.used >= this.maximumCalls) return false;
    this.used += 1;
    return true;
  }

  get usedCalls(): number {
    return this.used;
  }
}

export class StaticKillSwitch {
  constructor(private active = true) {}

  async isActive(): Promise<boolean> {
    return this.active;
  }

  setActive(active: boolean): void {
    this.active = active;
  }
}
