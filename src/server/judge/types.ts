import type { SupportedCallLocale } from "../calle";
import type {
  ManagerDecision,
  ManagerEscalationTask,
  RestrictedManagerAction,
} from "../escalation";

/** Redacted view of the server-owned escalation scenario. */
export type JudgeRunScenario = {
  organizationName: string;
  sku: string;
  requiredQuantity: number;
  stockoutAt: string;
  rejectedOffers: Array<{
    supplierName: string;
    failedChecks: string[];
    requiresHumanChecks: string[];
  }>;
};

export type JudgeSession = {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  remainingCalls: 1;
  mode: "LIVE_CALLE" | "MOCK";
  /** Minted by the backend. The browser never chooses this. */
  runId: string;
  scenario: JudgeRunScenario;
};
export type CreateJudgeSessionRequest = {
  accessCode: string;
};

export type StartManagerCallRequest = {
  runId: string;
  phoneE164: string;
  locale: SupportedCallLocale;
  explicitConsent: true;
  idempotencyKey: string;
};

export type StartManagerCallResponse = {
  runId: string;
  callTaskId: string;
  status: "PENDING" | "QUEUED" | "CALLING" | "COMPLETED" | "FAILED";
  runtime: "LIVE_CALLE" | "MOCK";
};

/** Terminal manager outcome, surfaced only once actually recorded. */
export type JudgeManagerResult = {
  callId: string;
  outcome: ManagerEscalationTask["outcome"];
  rawDecision: ManagerDecision;
  effectiveDecision: ManagerDecision;
  restrictedActionsRequested: RestrictedManagerAction[];
  preferredContactAt: string | null;
  evidenceStatus: "VERIFIED" | "UNVERIFIED";
  evidenceExcerpt: string | null;
  summary: string | null;
  /** Structurally impossible to be true - a voice call cannot change policy. */
  policyChanged: false;
  orderCreated: false;
};

export type JudgeRunStatus = {
  runId: string;
  state:
    | "HUMAN_ESCALATION_REQUIRED"
    | "MANAGER_CALLING"
    | "MANAGER_RESPONSE_RECEIVED"
    | "AUTHENTICATED_APPROVAL_REQUIRED"
    | "PROOF_SIGNED"
    | "HUMAN_REVIEW"
    | "FAILED";
  terminal: boolean;
  /** Reported by the backend. Never inferred by the browser. */
  runtime: "LIVE_CALLE" | "MOCK";
  manager: JudgeManagerResult | null;
};
