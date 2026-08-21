import {
  calculateShortage,
  selectBestCompliantOffer,
  type SupplierOffer,
} from "../../domain";
import type {
  SupplierCallingPort,
  SupplierCallTask,
} from "../calle";
import type {
  AuditEvent,
  DecisionProof,
  PurchaseOrderPort,
  SupplierContact,
  WorkflowInput,
  WorkflowResult,
} from "./types";
import { toSupplierCallRequest } from "./types";

type Clock = () => Date;

function resultToOffer(
  supplier: SupplierContact,
  task: SupplierCallTask,
  workflowId: string,
  sku: string,
): SupplierOffer {
  const result = task.structuredResult;
  const requiredFieldsPresent =
    task.taskCompleted &&
    result !== null &&
    result.availableQuantity !== null &&
    result.unitPrice !== null &&
    result.currency !== null &&
    result.deliveryAt !== null &&
    !result.optOutRequested;

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
    commercialTermsChanged: result?.commercialTermsChanged ?? true,
    evidenceComplete: requiredFieldsPresent,
    completionConfidence: task.completionConfidence ?? 0,
    attemptCount: 1,
  };
}

export class ProcurementWorkflow {
  constructor(
    private readonly supplierCalls: SupplierCallingPort,
    private readonly purchaseOrders: PurchaseOrderPort,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async run(input: WorkflowInput): Promise<WorkflowResult> {
    const auditTimeline: AuditEvent[] = [];
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

    record("WORKFLOW_STARTED", "Autonomous procurement workflow started", {
      workflowId: input.workflowId,
      supplierCount: input.suppliers.length,
    });

    if (!input.autonomousExecutionEnabled) {
      record("WORKFLOW_BLOCKED", "Operator kill switch is active");
      return {
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      };
    }

    if (
      input.suppliers.length > input.callAuthorization.maximumCalls ||
      input.suppliers.length > 5
    ) {
      record(
        "WORKFLOW_BLOCKED",
        "Supplier count exceeds the authorized call limit",
        {
          supplierCount: input.suppliers.length,
          authorizedCalls: input.callAuthorization.maximumCalls,
        },
      );
      return {
        workflowId: input.workflowId,
        status: "EXECUTION_BLOCKED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      };
    }

    const forecast = calculateShortage(input.inventory);
    record("SHORTAGE_CALCULATED", "Inventory shortage calculation completed", {
      sku: forecast.sku,
      requiredQuantity: forecast.requiredQuantity,
      projectedAvailable: forecast.projectedAvailable,
      shortageDetected: forecast.shortageDetected,
    });

    if (!forecast.shortageDetected) {
      record("NO_ACTION_REQUIRED", "No replenishment is required");
      return {
        workflowId: input.workflowId,
        status: "NO_ACTION_REQUIRED",
        decision: null,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      };
    }

    const offers: SupplierOffer[] = [];

    for (const supplier of input.suppliers) {
      const task = await this.supplierCalls.startSupplierCall(
        toSupplierCallRequest(input, supplier, forecast.requiredQuantity),
        input.callAuthorization,
      );

      offers.push(
        resultToOffer(
          supplier,
          task,
          input.workflowId,
          input.inventory.sku,
        ),
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
        },
      );
    }

    const decision = selectBestCompliantOffer(
      offers,
      forecast,
      input.procurementPolicy,
      input.exchangeRates,
    );

    for (const rejected of decision.rejectedOffers) {
      record(
        "OFFER_REJECTED",
        `${rejected.offer.supplierName} failed policy validation`,
        {
          supplierId: rejected.offer.supplierId,
          failedChecks: rejected.validation.failedCheckIds.join(","),
        },
      );
    }

    if (
      decision.status !== "ORDER_APPROVED" ||
      !decision.selectedOffer ||
      !decision.validation
    ) {
      record(
        "HUMAN_EXCEPTION_REQUIRED",
        "No offer qualified for autonomous execution",
      );

      return {
        workflowId: input.workflowId,
        status: "HUMAN_EXCEPTION_REQUIRED",
        decision,
        purchaseOrder: null,
        proof: null,
        auditTimeline,
      };
    }

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

    const purchaseOrder = await this.purchaseOrders.createPurchaseOrder({
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
    };

    return {
      workflowId: input.workflowId,
      status: "ORDER_CREATED",
      decision,
      purchaseOrder,
      proof,
      auditTimeline,
    };
  }
}
