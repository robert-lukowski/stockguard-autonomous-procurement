import type { SupportedCallLocale } from "../calle";

export type JudgeSession = {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  remainingCalls: 1;
  mode: "LIVE_CALLE";
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
  status: "QUEUED" | "CALLING";
  runtime: "LIVE_CALLE";
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
};
