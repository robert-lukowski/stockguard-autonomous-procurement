import {
  calculateShortage,
  selectBestCompliantOffer,
  type SupplierOffer,
} from "../../domain";
import type {
  CallAuthorization,
  SupplierCallingPort,
  SupplierCallRequest,
  SupplierCallTask,
} from "../calle";
import type {
  AuditEvent,
  DecisionProof,
  PurchaseOrder,
  PurchaseOrderPort,
  SupplierContact,
  WorkflowInput,
  WorkflowResult,
} from "./types";
import { toSupplierCallRequest } from "./types";
import { ProcurementStateMachine, type WorkflowStateEvent } from "./stateMachine";
import {
  defaultCallExecutionPolicy,
  InMemoryWorkflowRunStore,
  withTimeout,
  type CallExecutionPolicy,
  type WorkflowRunStore,
} from "./resilience";

type Clock = () => Date;

function resultToOffer(
  supplier: SupplierContact,
  task: SupplierCallTask,
  workflowId: string,
  sku: string,
  attemptCount: number,
): SupplierOffer {
  const result = task.structuredResult;
  const evidenceFields = [
    "skuConfirmed",
    "availableQuantity",
    "unitPrice",
    "currency",
    "deliveryAt",
    "offerValidUntil",
    "commercialTermsChanged",
  ] as const;
  const evidenceStatus = Object.fromEntries(
    evidenceFields.map((field) => [
      field,
      result?.[field] === null || result?.[field] === undefined
        ? "NOT_PROVIDED"
        : task.fieldEvidence[field]?.verified
          ? "VERIFIED"
          : "UNVERIFIED",
    ]),
  ) as SupplierOffer["evidenceStatus"];
  const requiredFieldsVerified =
    task.taskCompleted &&
    task.schemaValidation.valid &&
    result !== null &&
    result.availableQuantity !== null &&
    result.unitPrice !== null &&
    result.currency !== null &&
    result.deliveryAt !== null &&
    !result.optOutRequested &&
    evidenceFields.every((field) => evidenceStatus[field] === "VERIFIED");

  return {
    offerId: `${workflowId}:${supplier.supplierId}`,
    supplierId: supplier.supplierId,
    supplierName: supplier.supplierName,
    approvedSupplier: supplier.approved,
    consentVerified: supplier.consentVerified,
    language: result?.language ?? supplier.locale,
    sku,
    exactSkuConfirmed: result?.skuConfirmed ?? false,
    availableQuantity: result?.availableQuantity ?? 0,
    unitPrice: result?.unitPrice ?? 0,
    currency: result?.currency ?? "EUR",
    deliveryAt: result?.deliveryAt ?? "9999-12-31T23:59:59Z",
    offerValidUntil: result?.offerValidUntil ?? null,
    commercialTermsChanged: result?.commercialTermsChanged ?? true,
    evidenceComplete: requiredFieldsVerified,
    evidenceStatus,
    evidenceByField: task.fieldEvidence,
    completionConfidence: task.completionConfidence ?? 0,
    attemptCount,
  };
}

function unresolvedTask(
  callId: string,
  outcome: "TIMEOUT" | "FAILED",
  message: string,
): SupplierCallTask {
  return {
    callId,
    status: "failed",
    taskCompleted: false,
    completionConfidence: 0,
    structuredResult: null,
    evidence: [message],
    fieldEvidence: {},
    schemaValidation: {
      valid: false,
      issues: [{ field: "$", message }],
    },
    outcome,
  };
}

export class ProcurementWorkflow {
  constructor(
    private readonly supplierCalls: SupplierCallingPort,
    private readonly purchaseOrders: PurchaseOrderPort,
    private readonly clock: Clock = () => new Date(),
    private readonly stateObserver?: (event: WorkflowStateEvent) => void,
    private readonly runStore: WorkflowRunStore = new InMemoryWorkflowRunStore(),
    private readonly callPolicy: CallExecutionPolicy = defaultCallExecutionPolicy,
  ) {}

  private async executeSupplierCall(
    request: SupplierCallRequest,
    authorization: CallAuthorization,
    onRetry: (attempt: number, outcome: SupplierCallTask["outcome"]) => void,
  ): Promise<{ task: SupplierCallTask; attemptCount: number }> {
    const maximumAttempts = Math.min(
      authorization.maximumCalls,
      this.callPolicy.maximumAttempts,
    );
    let lastTask = unresolvedTask(
      `unresolved-${request.workflowId}-${request.supplierId}`,
      "FAILED",
      "Supplier call was not started",
    );

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        let task = await withTimeout(
          this.supplierCalls.startSupplierCall(
            { ...request, attemptNumber: attempt },
            authorization,
          ),
          this.callPolicy.timeoutMs,
        );

        for (
          let poll = 0;
          ["planned", "queued", "in_progress"].includes(task.status) &&
          poll < this.callPolicy.maximumPolls;
          poll += 1
        ) {
          task = await withTimeout(
            this.supplierCalls.getSupplierCall(task.callId),
            this.callPolicy.timeoutMs,
          );
        }

        if (["planned", "queued", "in_progress"].includes(task.status)) {
          task = unresolvedTask(
            task.callId,
            "TIMEOUT",
            "CALL-E result did not reach a terminal state within the polling limit",
          );
        }
        lastTask = task;
      } catch (error) {
        const timedOut = error instanceof Error && error.message === "CALL_TIMEOUT";
        lastTask = unresolvedTask(
          `failed-${request.workflowId}-${request.supplierId}-${attempt}`,
          timedOut ? "TIMEOUT" : "FAILED",
          timedOut
            ? "CALL-E operation exceeded the configured timeout"
            : "CALL-E operation failed before a structured result was available",
        );
      }

      const retryable = ["NO_ANSWER", "TIMEOUT", "FAILED"].includes(
        lastTask.outcome,
      );
      if (!retryable || attempt === maximumAttempts) {
        return { task: lastTask, attemptCount: attempt };
      }
      onRetry(attempt + 1, lastTask.outcome);
    }

    return { task: lastTask, attemptCount: maximumAttempts };
  }

  async run(input: WorkflowInput): Promise<WorkflowResult> {
    const stateMachine = new ProcurementStateMachine(
      input.workflowId,
      this.clock,
      this.stateObserver,
    );
    const auditTimeline: AuditEvent[] = [];
    const finish = (
      result: Omit<WorkflowResult, "workflowState" | "stateHistory">,
    ): WorkflowResult => {
      const completed = {
        ...result,
        workflowState: stateMachine.current,
        stateHistory: stateMachine.history,
      };
      this.runStore.complete(input.workflowId, completed);
      return completed;
    };
    const record = (
      type: AuditEvent["type"],
      summary: string,
      evidence: AuditEvent["evidence"] = {},
    ) => {
      auditTimeline.push({
        sequence: auditTimeline.length + 1,
        type,
        at: this.clock().toISOString(),
        summary,
        evidence,
      });
    };

    if (this.runStore.begin(input.workflowId) === "DUPLICATE") {
      const existing = this.runStore.getResult(input.workflowId);
      if (existing) return existing;
      stateMachine.transition("CANCELLED", "Duplicate run is already in progress");
      record("DUPLICATE_RUN_BLOCKED", "Duplicate workflow execution blocked", {
        workflowId: input.workflowId,
      });
      return {
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
        workflowState: stateMachine.current,
        stateHistory: stateMachine.history,
      };
    }

    if (this.runStore.isCancelled(input.workflowId)) {
      stateMachine.transition("CANCELLED", "Cancellation was requested before execution");
      record("WORKFLOW_CANCELLED", "Workflow cancelled before supplier contact", {
        workflowId: input.workflowId,
      });
      return finish({
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }

    record("WORKFLOW_STARTED", "Autonomous procurement workflow started", {
      workflowId: input.workflowId,
      supplierCount: input.suppliers.length,
    });

    if (!input.autonomousExecutionEnabled) {
      stateMachine.transition("CANCELLED", "Operator kill switch is active");
      record("WORKFLOW_BLOCKED", "Operator kill switch is active");
      return finish({
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }

    if (
      input.suppliers.length > input.callAuthorization.maximumCalls ||
      input.suppliers.length > 5
    ) {
      stateMachine.transition("CANCELLED", "Authorized call limit exceeded");
      record(
        "WORKFLOW_BLOCKED",
        "Supplier count exceeds the authorized call limit",
        {
          supplierCount: input.suppliers.length,
          authorizedCalls: input.callAuthorization.maximumCalls,
        },
      );
      return finish({
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }

    const forecast = calculateShortage(input.inventory);
    stateMachine.transition("DEMAND_DETECTED", "Demand and inventory evaluated");
    record("SHORTAGE_CALCULATED", "Inventory shortage calculation completed", {
      sku: forecast.sku,
      requiredQuantity: forecast.requiredQuantity,
      projectedAvailable: forecast.projectedAvailable,
      shortageDetected: forecast.shortageDetected,
    });

    if (!forecast.shortageDetected) {
      stateMachine.transition("CANCELLED", "No inventory shortage detected");
      record("NO_ACTION_REQUIRED", "No replenishment is required");
      return finish({
        workflowId: input.workflowId,
        status: "NO_ACTION_REQUIRED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }

    stateMachine.transition(
      "CONTACTS_PLANNED",
      `${input.suppliers.length} approved supplier contacts planned`,
    );
    const offers: SupplierOffer[] = [];

    for (const supplier of input.suppliers) {
      if (this.runStore.isCancelled(input.workflowId)) {
        stateMachine.transition("CANCELLED", "Cancellation requested during supplier contact");
        record("WORKFLOW_CANCELLED", "Workflow cancelled before the next supplier call", {
          supplierId: supplier.supplierId,
        });
        return finish({
          workflowId: input.workflowId,
          status: "EXECUTION_BLOCKED",
          decision: null,
          purchaseOrder: null,
          proof: null,
          auditTimeline,
        });
      }
      stateMachine.transition("CALLING", `Contacting ${supplier.supplierName}`);
      const { task, attemptCount } = await this.executeSupplierCall(
        toSupplierCallRequest(input, supplier, forecast.requiredQuantity),
        input.callAuthorization,
        (nextAttempt, outcome) => {
          record(
            "CALL_RETRY_SCHEDULED",
            `Bounded retry scheduled for ${supplier.supplierName}`,
            { supplierId: supplier.supplierId, nextAttempt, previousOutcome: outcome },
          );
        },
      );

      offers.push(
        resultToOffer(
          supplier,
          task,
          input.workflowId,
          input.inventory.sku,
          attemptCount,
        ),
      );
      stateMachine.transition(
        "OFFER_RECEIVED",
        `Call outcome received from ${supplier.supplierName}: ${task.status}`,
      );

      record(
        "CALL_COMPLETED",
        `Supplier call completed for ${supplier.supplierName}`,
        {
          supplierId: supplier.supplierId,
          callId: task.callId,
          taskCompleted: task.taskCompleted,
          confidence: task.completionConfidence,
          evidenceItems: task.evidence.length,
          outcome: task.outcome,
          attemptCount,
        },
      );
      if (task.outcome === "TIMEOUT") {
        record("CALL_TIMEOUT", `Supplier call timed out for ${supplier.supplierName}`, {
          supplierId: supplier.supplierId,
          callId: task.callId,
          attemptCount,
        });
      }
    }

    stateMachine.transition("VALIDATING", "Structured supplier results ready for validation");
    const decision = selectBestCompliantOffer(
      offers,
      forecast,
      input.procurementPolicy,
      input.exchangeRates,
      this.clock().toISOString(),
    );
    stateMachine.transition("POLICY_CHECK", "Deterministic procurement rules evaluated");

    for (const rejected of decision.rejectedOffers) {
      record(
        "OFFER_REJECTED",
        `${rejected.offer.supplierName} failed policy validation`,
        {
          supplierId: rejected.offer.supplierId,
          failedChecks: rejected.validation.failedCheckIds.join(","),
          requiresHuman: rejected.validation.humanReviewCheckIds.join(","),
        },
      );
    }

    if (
      decision.status !== "ORDER_APPROVED" ||
      !decision.selectedOffer ||
      !decision.validation
    ) {
      stateMachine.transition("NO_COMPLIANT_OFFER", "Every supplier offer failed at least one deterministic policy rule");
      record("NO_COMPLIANT_OFFER", "No supplier offer passed every machine-enforced policy check", {
        rejectedOffers: decision.rejectedOffers.length,
      });
      stateMachine.transition("HUMAN_ESCALATION_REQUIRED", "A bounded manager escalation is required");
      record(
        "HUMAN_EXCEPTION_REQUIRED",
        "No offer qualified; no policy override or purchase order was created",
      );

      return finish({
        workflowId: input.workflowId,
        status: "HUMAN_ESCALATION_REQUIRED",
        decision,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }

    stateMachine.transition("SELECTED", `${decision.selectedOffer.supplierName} selected`);
    record(
      "OFFER_SELECTED",
      `${decision.selectedOffer.supplierName} selected`,
      {
        supplierId: decision.selectedOffer.supplierId,
        totalPriceEur: decision.selectedOffer.totalPriceEur,
        deliveryAt: decision.selectedOffer.deliveryAt,
      },
    );

    record(
      "POLICY_PASSED",
      "Every machine-enforced procurement check passed",
      {
        policyVersion: decision.validation.policyVersion,
        passedChecks: decision.validation.checks.length,
      },
    );

    if (this.runStore.isCancelled(input.workflowId)) {
      stateMachine.transition("CANCELLED", "Cancellation requested before order preparation");
      record("WORKFLOW_CANCELLED", "Workflow cancelled before purchase-order creation", {
        supplierId: decision.selectedOffer.supplierId,
      });
      return finish({
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }

    let purchaseOrder: PurchaseOrder;
    try {
      purchaseOrder = await this.purchaseOrders.createPurchaseOrder({
        idempotencyKey: `${input.workflowId}:purchase-order`,
        workflowId: input.workflowId,
        supplierId: decision.selectedOffer.supplierId,
        supplierName: decision.selectedOffer.supplierName,
        sku: decision.selectedOffer.sku,
        quantity: forecast.requiredQuantity,
        unitPriceEur: decision.selectedOffer.unitPriceEur,
        totalPriceEur:
          decision.selectedOffer.unitPriceEur * forecast.requiredQuantity,
        deliveryAt: decision.selectedOffer.deliveryAt,
        policyVersion: decision.validation.policyVersion,
      });
    } catch {
      stateMachine.transition("FAILED", "Purchase-order adapter failed closed");
      record("WORKFLOW_FAILED", "Synthetic purchase-order creation failed", {
        idempotencyKey: `${input.workflowId}:purchase-order`,
      });
      return finish({
        workflowId: input.workflowId,
        status: "FAILED",
        decision,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      });
    }
    stateMachine.transition("ORDER_PREPARED", "Synthetic purchase order prepared within policy");

    record(
      "PURCHASE_ORDER_CREATED",
      `Synthetic purchase order ${purchaseOrder.purchaseOrderId} created`,
      {
        purchaseOrderId: purchaseOrder.purchaseOrderId,
        orderValueEur: purchaseOrder.totalPriceEur,
        environment: purchaseOrder.environment,
      },
    );

    const proof: DecisionProof = {
      workflowId: input.workflowId,
      policyVersion: decision.validation.policyVersion,
      selectedSupplierId: decision.selectedOffer.supplierId,
      selectedOfferId: decision.selectedOffer.offerId,
      passedChecks: decision.validation.checks
        .filter((check) => check.passed)
        .map((check) => check.id),
      rejectedSupplierIds: decision.rejectedOffers.map(
        ({ offer }) => offer.supplierId,
      ),
      orderValueEur: purchaseOrder.totalPriceEur,
      explanation: decision.reason,
      managerEscalation: null,
      ruleTrace: [
        {
          supplierId: decision.selectedOffer.supplierId,
          checks: decision.validation.checks.map(({ id, status, evidence, inputs }) => ({
            id,
            status,
            evidence,
            inputs,
          })),
        },
        ...decision.rejectedOffers.map(({ offer, validation }) => ({
          supplierId: offer.supplierId,
          checks: validation.checks.map(({ id, status, evidence, inputs }) => ({
            id,
            status,
            evidence,
            inputs,
          })),
        })),
      ],
    };

    return finish({
      workflowId: input.workflowId,
      status: "ORDER_CREATED",
      decision,
      purchaseOrder,
      proof,
      auditTimeline,
    });
  }
}
