import { validateManagerEscalationAuthorization } from "./safety";
import type {
  ManagerDecision,
  ManagerEscalationAuthorization,
  ManagerEscalationPort,
  ManagerEscalationRequest,
  ManagerEscalationStructuredResult,
  ManagerEscalationTask,
  RestrictedManagerAction,
} from "./types";
import { validateManagerEscalationResult } from "./validateManagerEscalation";

export type MockManagerResponse =
  | ManagerDecision
  | "ATTEMPT_POLICY_OVERRIDE"
  | "NO_ANSWER"
  | "UNVERIFIED_RESPONSE";

function resultForPreset(preset: MockManagerResponse): ManagerEscalationStructuredResult {
  const restrictedActionsRequested: RestrictedManagerAction[] =
    preset === "ATTEMPT_POLICY_OVERRIDE" ? ["INCREASE_BUDGET"] : [];
  const decision: ManagerDecision =
    preset === "ATTEMPT_POLICY_OVERRIDE"
      ? "ACKNOWLEDGE_AND_START_HUMAN_SOURCING"
      : preset === "NO_ANSWER" || preset === "UNVERIFIED_RESPONSE"
        ? "DECLINE_ESCALATION"
        : preset;

  return {
    decision,
    preferredContactAt:
      decision === "RETRY_APPROVED_SUPPLIERS_LATER"
        ? "2026-08-21T14:30:00Z"
        : null,
    restrictedActionsRequested,
    optOutRequested: decision === "DECLINE_ESCALATION",
    summary:
      preset === "ATTEMPT_POLICY_OVERRIDE"
        ? "Manager asked to increase the budget and buy anyway; StockGuard recorded the request without changing policy."
        : "Synthetic manager response captured for the Judge Mode preview.",
  };
}
export class MockManagerEscalationAdapter implements ManagerEscalationPort {
  private readonly tasksByIdempotencyKey = new Map<string, ManagerEscalationTask>();
  private readonly usedSessions = new Set<string>();

  constructor(
    private readonly preset: MockManagerResponse = "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
  ) {}

  async startManagerEscalation(
    request: ManagerEscalationRequest,
    authorization: ManagerEscalationAuthorization,
  ): Promise<ManagerEscalationTask> {
    validateManagerEscalationAuthorization(request, authorization);
    const existing = this.tasksByIdempotencyKey.get(request.idempotencyKey);
    if (existing) return structuredClone(existing);
    if (this.usedSessions.has(request.sessionId)) {
      throw new Error("Judge session call limit has already been consumed");
    }
    this.usedSessions.add(request.sessionId);

    if (this.preset === "NO_ANSWER") {
      const noAnswer: ManagerEscalationTask = {
        callId: `mock-manager-${request.runId}`,
        status: "failed",
        outcome: "NO_ANSWER",
        taskCompleted: false,
        structuredResult: null,
        evidence: ["Synthetic no-answer outcome"],
        fieldEvidence: {},
        schemaValidation: { valid: false, issues: [{ field: "$", message: "No response received" }] },
      };
      this.tasksByIdempotencyKey.set(request.idempotencyKey, noAnswer);
      return structuredClone(noAnswer);
    }

    const structuredResult = resultForPreset(this.preset);
    const decisionEvidence = `Synthetic manager response: ${structuredResult.decision}`;
    const validation = validateManagerEscalationResult({
      decision: structuredResult.decision,
      ...(structuredResult.preferredContactAt
        ? {
            preferredContactAt: structuredResult.preferredContactAt,
            preferredContactEvidence: `Synthetic callback time: ${structuredResult.preferredContactAt}`,
          }
        : {}),
      restrictedActionsRequested: structuredResult.restrictedActionsRequested,
      optOutRequested: structuredResult.optOutRequested,
      managerSummary: structuredResult.summary ?? "",
      decisionEvidence,
    });
    const task: ManagerEscalationTask = {
      callId: `mock-manager-${request.runId}`,
      status: "completed",
      outcome: "ANSWERED",
      taskCompleted: true,
      structuredResult: validation.result,
      evidence: ["AI disclosure delivered", "Synthetic scenario disclosed", "Bounded response captured"],
      fieldEvidence: {
        decision: {
          field: "decision",
          source: "transcript",
          excerpt: decisionEvidence,
          verified: this.preset !== "UNVERIFIED_RESPONSE",
        },
      },
      schemaValidation: { valid: validation.valid, issues: validation.issues },
    };
    this.tasksByIdempotencyKey.set(request.idempotencyKey, task);
    return structuredClone(task);
  }
}
