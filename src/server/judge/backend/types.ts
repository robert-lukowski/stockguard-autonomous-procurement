import type {
  ManagerEscalationContext,
  ManagerEscalationPort,
  ManagerEscalationTask,
} from "../../escalation";
import type { SupportedCallLocale } from "../../calle";

export type AccessCodeSecret = {
  algorithm: "PBKDF2-SHA256";
  saltBase64: string;
  derivedKeyBase64: string;
  iterations: number;
};
export interface AccessCodeSecretPort {
  getSecret(): Promise<AccessCodeSecret>;
}

export type StoredCallClaim = {
  idempotencyKey: string;
  runId: string;
  phoneHash: string;
  locale: SupportedCallLocale;
  consentRecordedAt: string;
  status: "PENDING" | "QUEUED" | "CALLING" | "COMPLETED" | "FAILED";
  callTaskId: string | null;
};

export type StoredJudgeSession = {
  sessionId: string;
  /**
   * The server-owned run this session may act on. A session can start and read
   * exactly one run, and the browser never chooses it.
   */
  runId: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  status: "ACTIVE" | "CONSUMED" | "REVOKED";
  claims: Record<string, StoredCallClaim>;
};

export type CallClaimInput = {
  sessionId: string;
  tokenHash: string;
  idempotencyKey: string;
  runId: string;
  phoneHash: string;
  locale: SupportedCallLocale;
  consentRecordedAt: string;
  now: string;
};

export type CallClaimResult =
  | { kind: "CLAIMED"; session: StoredJudgeSession; claim: StoredCallClaim }
  | { kind: "DUPLICATE"; session: StoredJudgeSession; claim: StoredCallClaim }
  | { kind: "NOT_FOUND" }
  | { kind: "TOKEN_INVALID" }
  | { kind: "EXPIRED" }
  | { kind: "CONSUMED" }
  | { kind: "REVOKED" };

export interface JudgeSessionStore {
  create(session: StoredJudgeSession): Promise<void>;
  getSession(sessionId: string): Promise<StoredJudgeSession | null>;
  claimCall(input: CallClaimInput): Promise<CallClaimResult>;
  completeClaim(
    sessionId: string,
    idempotencyKey: string,
    update: Pick<StoredCallClaim, "status" | "callTaskId">,
  ): Promise<void>;
  revoke(sessionId: string): Promise<void>;
}

export interface SessionRateLimiter {
  allow(key: string, now: Date): Promise<boolean>;
}

export interface GlobalCallBudget {
  claim(): Promise<boolean>;
}

export interface GlobalKillSwitch {
  isActive(): Promise<boolean>;
}

export interface EscalationContextPort {
  getEscalationContext(runId: string): Promise<ManagerEscalationContext | null>;
}

/** A run identifier and context minted by the backend, never by the browser. */
export type PreparedJudgeRun = {
  runId: string;
  context: ManagerEscalationContext;
};

/**
 * Mints the server-owned escalation run a judge session is allowed to act on.
 *
 * The browser cannot manufacture workflow eligibility: it never supplies a
 * runId, a workflow state, or a set of rejected offers.
 */
export interface JudgeRunPreparationPort {
  prepareRun(sessionId: string): Promise<PreparedJudgeRun>;
}

/**
 * Read side of the manager result sink. Kept separate from the sink so the
 * service can read a recorded terminal result without touching mutable
 * storage internals.
 */
export interface ManagerResultReader {
  read(runId: string): Promise<ManagerEscalationTask | null>;
}

export type JudgeBackendDependencies = {
  secretStore: AccessCodeSecretPort;
  sessionStore: JudgeSessionStore;
  rateLimiter: SessionRateLimiter;
  callBudget: GlobalCallBudget;
  killSwitch: GlobalKillSwitch;
  escalationContext: EscalationContextPort;
  managerCalls: ManagerEscalationPort;
  runPreparation: JudgeRunPreparationPort;
  managerResults: ManagerResultReader;
};
