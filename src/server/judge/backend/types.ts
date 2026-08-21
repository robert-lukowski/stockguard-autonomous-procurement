import type { ManagerEscalationContext, ManagerEscalationPort } from "../../escalation";
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

export type JudgeBackendDependencies = {
  secretStore: AccessCodeSecretPort;
  sessionStore: JudgeSessionStore;
  rateLimiter: SessionRateLimiter;
  callBudget: GlobalCallBudget;
  killSwitch: GlobalKillSwitch;
  escalationContext: EscalationContextPort;
  managerCalls: ManagerEscalationPort;
};
