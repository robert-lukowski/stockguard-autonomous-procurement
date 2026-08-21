import type { SupportedCallLocale } from "../calle";

export type SafeManagerDecision =
  | "ACKNOWLEDGE_AND_START_HUMAN_SOURCING"
  | "RETRY_APPROVED_SUPPLIERS_LATER"
  | "REQUEST_WRITTEN_REPORT"
  | "DECLINE_ESCALATION";

export type ManagerDecision =
  | SafeManagerDecision
  | "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL";

export type RestrictedManagerAction =
  | "INCREASE_BUDGET"
  | "CHANGE_PROCUREMENT_POLICY"
  | "APPROVE_UNKNOWN_SUPPLIER"
  | "ACCEPT_CHANGED_LEGAL_TERMS"
  | "CREATE_REAL_ORDER";

export type ManagerEscalationStructuredResult = {
  decision: ManagerDecision;
  preferredContactAt: string | null;
  restrictedActionsRequested: RestrictedManagerAction[];
  optOutRequested: boolean;
  summary: string | null;
};

export type ManagerEvidenceField = "decision" | "preferredContactAt";

export type ManagerFieldEvidence = {
  field: ManagerEvidenceField;
  source: "transcript" | "recipient_result";
  excerpt: string;
  verified: boolean;
};

export type ManagerEscalationTask = {
  callId: string;
  status: "planned" | "queued" | "in_progress" | "completed" | "failed";
  outcome: "ANSWERED" | "NO_ANSWER" | "VOICEMAIL" | "TIMEOUT" | "FAILED";
  taskCompleted: boolean;
  structuredResult: ManagerEscalationStructuredResult | null;
  evidence: string[];
  fieldEvidence: Partial<Record<ManagerEvidenceField, ManagerFieldEvidence>>;
  schemaValidation: {
    valid: boolean;
    issues: Array<{ field: string; message: string }>;
  };
};

export type ManagerEscalationContext = {
  organizationName: "Northstar Manufacturing";
  sku: string;
  requiredQuantity: number;
  stockoutAt: string;
  rejectedOffers: Array<{
    supplierName: string;
    failedChecks: string[];
    requiresHumanChecks: string[];
  }>;
};

export type ManagerEscalationRequest = {
  runId: string;
  sessionId: string;
  attemptNumber: 1;
  idempotencyKey: string;
  phoneE164: string;
  locale: SupportedCallLocale;
  consentConfirmed: true;
  context: ManagerEscalationContext;
};

export type ManagerEscalationAuthorization = {
  sessionId: string;
  accessCodeVerifiedServerSide: true;
  issuedAt: string;
  expiresAt: string;
  allowedPhoneE164: string;
  maximumCalls: 1;
  consentRecordedAt: string;
  killSwitchActive: boolean;
};

export type ManagerEscalationRecord = {
  runId: string;
  callId: string;
  locale: SupportedCallLocale;
  outcome: ManagerEscalationTask["outcome"];
  rawDecision: ManagerDecision;
  effectiveDecision: ManagerDecision;
  preferredContactAt: string | null;
  restrictedActionsRequested: RestrictedManagerAction[];
  evidenceStatus: "VERIFIED" | "UNVERIFIED";
  evidenceExcerpt: string | null;
  summary: string | null;
  policyChanged: false;
  orderCreated: false;
};

export interface ManagerEscalationPort {
  startManagerEscalation(
    request: ManagerEscalationRequest,
    authorization: ManagerEscalationAuthorization,
  ): Promise<ManagerEscalationTask>;
}
