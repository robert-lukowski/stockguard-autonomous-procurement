import type {
  ManagerDecision,
  ManagerEscalationRecord,
  ManagerEscalationStructuredResult,
  ManagerEscalationTask,
  RestrictedManagerAction,
} from "./types";

const decisions = new Set<ManagerDecision>([
  "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
  "RETRY_APPROVED_SUPPLIERS_LATER",
  "REQUEST_WRITTEN_REPORT",
  "DECLINE_ESCALATION",
  "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL",
]);

const restrictedActions = new Set<RestrictedManagerAction>([
  "INCREASE_BUDGET",
  "CHANGE_PROCUREMENT_POLICY",
  "APPROVE_UNKNOWN_SUPPLIER",
  "ACCEPT_CHANGED_LEGAL_TERMS",
  "CREATE_REAL_ORDER",
]);

export function validateManagerEscalationResult(value: unknown): {
  valid: boolean;
  issues: Array<{ field: string; message: string }>;
  result: ManagerEscalationStructuredResult | null;
} {
  const issues: Array<{ field: string; message: string }> = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ field: "$", message: "Structured result must be an object" }],
      result: null,
    };
  }

  const record = value as Record<string, unknown>;
  for (const field of [
    "decision",
    "preferredContactAt",
    "restrictedActionsRequested",
    "optOutRequested",
    "summary",
  ]) {
    if (!(field in record)) issues.push({ field, message: "Required field is missing" });
  }

  if (typeof record.decision !== "string" || !decisions.has(record.decision as ManagerDecision)) {
    issues.push({ field: "decision", message: "Must be an allowed manager decision" });
  }
  if (
    record.preferredContactAt !== null &&
    (typeof record.preferredContactAt !== "string" ||
      !Number.isFinite(Date.parse(record.preferredContactAt)))
  ) {
    issues.push({ field: "preferredContactAt", message: "Must be a valid ISO date-time or null" });
  }
  if (!Array.isArray(record.restrictedActionsRequested)) {
    issues.push({ field: "restrictedActionsRequested", message: "Must be an array" });
  } else if (
    record.restrictedActionsRequested.some(
      (action) => typeof action !== "string" || !restrictedActions.has(action as RestrictedManagerAction),
    )
  ) {
    issues.push({ field: "restrictedActionsRequested", message: "Contains an unsupported restricted action" });
  }
  if (typeof record.optOutRequested !== "boolean") {
    issues.push({ field: "optOutRequested", message: "Must be boolean" });
  }
  if (record.summary !== null && typeof record.summary !== "string") {
    issues.push({ field: "summary", message: "Must be a string or null" });
  }

  return {
    valid: issues.length === 0,
    issues,
    result: issues.length === 0 ? (record as ManagerEscalationStructuredResult) : null,
  };
}
export function createManagerEscalationRecord(
  runId: string,
  locale: ManagerEscalationRecord["locale"],
  task: ManagerEscalationTask,
): ManagerEscalationRecord | null {
  const result = task.structuredResult;
  const decisionEvidence = task.fieldEvidence.decision;
  if (
    !task.taskCompleted ||
    task.outcome !== "ANSWERED" ||
    !task.schemaValidation.valid ||
    !result ||
    !decisionEvidence?.verified ||
    decisionEvidence.excerpt.trim().length === 0
  ) {
    return null;
  }

  const effectiveDecision: ManagerDecision = result.optOutRequested
    ? "DECLINE_ESCALATION"
    : result.restrictedActionsRequested.length > 0 ||
        result.decision === "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL"
      ? "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL"
      : result.decision;

  return {
    runId,
    callId: task.callId,
    locale,
    outcome: task.outcome,
    rawDecision: result.decision,
    effectiveDecision,
    preferredContactAt: result.preferredContactAt,
    restrictedActionsRequested: [...result.restrictedActionsRequested],
    evidenceStatus: "VERIFIED",
    evidenceExcerpt: decisionEvidence.excerpt,
    summary: result.summary,
    policyChanged: false,
    orderCreated: false,
  };
}
