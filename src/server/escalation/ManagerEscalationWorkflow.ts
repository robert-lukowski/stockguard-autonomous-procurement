import { appendWorkflowState } from "../workflow/stateMachine";
import type { AuditEvent, DecisionProof, WorkflowResult } from "../workflow/types";
import type {
  ManagerEscalationAuthorization,
  ManagerEscalationPort,
  ManagerEscalationRequest,
  ManagerEscalationTask,
} from "./types";
import { createManagerEscalationRecord } from "./validateManagerEscalation";

type Clock = () => Date;

export class ManagerEscalationWorkflow {
  constructor(
    private readonly escalationCalls: ManagerEscalationPort,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async run(
    baseResult: WorkflowResult,
    request: ManagerEscalationRequest,
    authorization: ManagerEscalationAuthorization,
  ): Promise<WorkflowResult> {
    if (
      baseResult.workflowId !== request.runId ||
      baseResult.status !== "HUMAN_ESCALATION_REQUIRED" ||
      baseResult.workflowState !== "HUMAN_ESCALATION_REQUIRED" ||
      baseResult.purchaseOrder !== null ||
      !baseResult.decision
    ) {
      throw new Error("Manager escalation is only allowed after a no-compliant-offer outcome");
    }

    let stateHistory = appendWorkflowState(
      baseResult.stateHistory,
      "MANAGER_CALLING",
      "One bounded manager escalation call started",
      this.clock().toISOString(),
    );
    const auditTimeline: AuditEvent[] = [...baseResult.auditTimeline];
    const record = (
      type: AuditEvent["type"],
      summary: string,
      evidence: AuditEvent["evidence"] = {},
    ) => auditTimeline.push({
      sequence: auditTimeline.length + 1,
      type,
      at: this.clock().toISOString(),
      summary,
      evidence,
    });
    record("MANAGER_ESCALATION_STARTED", "Bounded manager escalation started", {
      runId: request.runId,
      locale: request.locale,
      sessionId: request.sessionId,
    });

    let task: ManagerEscalationTask;
    try {
      task = await this.escalationCalls.startManagerEscalation(request, authorization);
    } catch {
      stateHistory = appendWorkflowState(
        stateHistory,
        "HUMAN_REVIEW",
        "Manager escalation failed closed",
        this.clock().toISOString(),
      );
      record("MANAGER_ESCALATION_FAILED", "Manager escalation failed without changing policy or creating an order");
      return {
        ...baseResult,
        auditTimeline,
        workflowState: "HUMAN_REVIEW",
        stateHistory,
        managerEscalation: null,
      };
    }

    stateHistory = appendWorkflowState(
      stateHistory,
      "MANAGER_RESPONSE_RECEIVED",
      `Manager call reached terminal outcome ${task.outcome}`,
      this.clock().toISOString(),
    );
    record("MANAGER_CALL_COMPLETED", "Manager escalation call reached a terminal outcome", {
      callId: task.callId,
      outcome: task.outcome,
      schemaValid: task.schemaValidation.valid,
    });

    const managerEscalation = createManagerEscalationRecord(
      request.runId,
      request.locale,
      task,
    );
    if (!managerEscalation) {
      stateHistory = appendWorkflowState(
        stateHistory,
        "HUMAN_REVIEW",
        "Manager response could not be verified against schema and evidence",
        this.clock().toISOString(),
      );
      record("MANAGER_ESCALATION_FAILED", "Unverified manager response was quarantined", {
        outcome: task.outcome,
        schemaValid: task.schemaValidation.valid,
      });
      return {
        ...baseResult,
        auditTimeline,
        workflowState: "HUMAN_REVIEW",
        stateHistory,
        managerEscalation: null,
      };
    }

    const requiresAuthenticatedApproval =
      managerEscalation.effectiveDecision === "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL";
    if (requiresAuthenticatedApproval) {
      stateHistory = appendWorkflowState(
        stateHistory,
        "AUTHENTICATED_APPROVAL_REQUIRED",
        "Restricted request requires authenticated portal approval",
        this.clock().toISOString(),
      );
      record("AUTHENTICATED_APPROVAL_REQUIRED", "Restricted request was recorded but not executed", {
        restrictedActions: managerEscalation.restrictedActionsRequested.join(","),
      });
    }
    record("MANAGER_DECISION_RECORDED", "Bounded manager decision recorded", {
      rawDecision: managerEscalation.rawDecision,
      effectiveDecision: managerEscalation.effectiveDecision,
      evidenceStatus: managerEscalation.evidenceStatus,
      policyChanged: false,
      orderCreated: false,
    });

    const decisionProof: DecisionProof = {
      workflowId: baseResult.workflowId,
      policyVersion: baseResult.decision.rejectedOffers[0]?.validation.policyVersion ?? "unknown",
      selectedSupplierId: null,
      selectedOfferId: null,
      passedChecks: [],
      rejectedSupplierIds: baseResult.decision.rejectedOffers.map(({ offer }) => offer.supplierId),
      orderValueEur: null,
      explanation: baseResult.decision.reason,
      managerEscalation,
      ruleTrace: baseResult.decision.rejectedOffers.map(({ offer, validation }) => ({
        supplierId: offer.supplierId,
        checks: validation.checks.map(({ id, status, evidence, inputs }) => ({
          id,
          status,
          evidence,
          inputs,
        })),
      })),
    };

    return {
      ...baseResult,
      status: requiresAuthenticatedApproval
        ? "AUTHENTICATED_APPROVAL_REQUIRED"
        : "ESCALATION_RECORDED",
      proof: decisionProof,
      managerEscalation,
      purchaseOrder: null,
      auditTimeline,
      workflowState: stateHistory.at(-1)?.to ?? "MANAGER_RESPONSE_RECEIVED",
      stateHistory,
    };
  }
}
