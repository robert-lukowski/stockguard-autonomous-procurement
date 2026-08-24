import { describe, expect, it } from "vitest";
import type {
  ExchangeRatesToEur,
  ProcurementPolicy,
} from "../../domain";
import {
  MockCallEAdapter,
  type CallAuthorization,
  type SupplierCallingPort,
  type SupplierCallRequest,
} from "../calle";
import {
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
  type SupplierContact,
  type WorkflowInput,
  InMemoryWorkflowRunStore,
} from ".";

const suppliers: SupplierContact[] = [
  {
    supplierId: "supplier-de-01",
    supplierName: "NordWerk Supply",
    phoneE164: "+15550100001",
    region: "DE",
    locale: "de-DE",
    approved: true,
    consentVerified: true,
  },
  {
    supplierId: "supplier-fr-01",
    supplierName: "Fourniture Atlas",
    phoneE164: "+15550100002",
    region: "FR",
    locale: "fr-FR",
    approved: true,
    consentVerified: true,
  },
  {
    supplierId: "supplier-pl-01",
    supplierName: "PolStock Components",
    phoneE164: "+15550100003",
    region: "PL",
    locale: "pl-PL",
    approved: true,
    consentVerified: true,
  },
];

const authorization: CallAuthorization = {
  workflowId: "wf-2026-081",
  approvedBy: "demo-operator",
  approvedAt: "2026-08-21T09:00:00Z",
  expiresAt: "2099-08-21T10:00:00Z",
  maximumCalls: 3,
  allowedSupplierIds: suppliers.map(({ supplierId }) => supplierId),
  allowedPhoneNumbers: suppliers.map(({ phoneE164 }) => phoneE164),
};

const policy: ProcurementPolicy = {
  version: "PROCUREMENT-2026-08-v3",
  autonomousOrderLimitEur: 500,
  unitPriceCeilingEur: 45,
  minimumConfidence: 0.9,
  maximumAttempts: 2,
  approvedCurrencies: ["EUR", "PLN"],
};

const rates: ExchangeRatesToEur = {
  EUR: 1,
  PLN: 0.2329,
  USD: 0.86,
  GBP: 1.16,
};

function workflowInput(
  overrides: Partial<WorkflowInput> = {},
): WorkflowInput {
  return {
    workflowId: "wf-2026-081",
    inventory: {
      sku: "CF-220",
      onHand: 8,
      confirmedDemand: 14,
      inboundConfirmed: 0,
      safetyStock: 2,
      stockoutAt: "2026-08-28T12:00:00+02:00",
    },
    suppliers,
    callAuthorization: authorization,
    procurementPolicy: policy,
    exchangeRates: rates,
    autonomousExecutionEnabled: true,
    ...overrides,
  };
}

describe("ProcurementWorkflow", () => {
  it("runs the complete synthetic workflow and creates a policy-compliant order", async () => {
    const purchaseOrders = new MockPurchaseOrderAdapter();
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      purchaseOrders,
      () => new Date("2026-08-21T09:42:00Z"),
    );

    const result = await workflow.run(workflowInput());

    expect(result.status).toBe("ORDER_CREATED");
    expect(result.purchaseOrder).toMatchObject({
      purchaseOrderId: "PO-1042",
      supplierId: "supplier-de-01",
      quantity: 8,
      totalPriceEur: 336,
      environment: "synthetic",
    });
    expect(result.proof?.passedChecks).toHaveLength(13);
    expect(result.proof?.ruleTrace).toHaveLength(3);
    expect(result.workflowState).toBe("ORDER_PREPARED");
    expect(result.proof?.rejectedSupplierIds).toEqual([
      "supplier-fr-01",
      "supplier-pl-01",
    ]);
    expect(result.auditTimeline.map(({ type }) => type)).toEqual([
      "WORKFLOW_STARTED",
      "SHORTAGE_CALCULATED",
      "CALL_COMPLETED",
      "CALL_COMPLETED",
      "CALL_COMPLETED",
      "OFFER_REJECTED",
      "OFFER_REJECTED",
      "OFFER_SELECTED",
      "POLICY_PASSED",
      "PURCHASE_ORDER_CREATED",
    ]);
    expect(purchaseOrders.createdOrders).toHaveLength(1);
  });

  it("stops before supplier contact when the kill switch is active", async () => {
    const purchaseOrders = new MockPurchaseOrderAdapter();
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      purchaseOrders,
    );

    const result = await workflow.run(
      workflowInput({ autonomousExecutionEnabled: false }),
    );

    expect(result.status).toBe("EXECUTION_BLOCKED");
    expect(result.auditTimeline.at(-1)?.type).toBe("WORKFLOW_BLOCKED");
    expect(purchaseOrders.createdOrders).toHaveLength(0);
  });

  it("makes no supplier calls when there is no predicted shortage", async () => {
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      new MockPurchaseOrderAdapter(),
    );

    const result = await workflow.run(
      workflowInput({
        inventory: {
          ...workflowInput().inventory,
          onHand: 30,
        },
      }),
    );

    expect(result.status).toBe("NO_ACTION_REQUIRED");
    expect(
      result.auditTimeline.some(({ type }) => type === "CALL_COMPLETED"),
    ).toBe(false);
  });

  it("blocks execution when requested calls exceed authorization", async () => {
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      new MockPurchaseOrderAdapter(),
    );

    const result = await workflow.run(
      workflowInput({
        callAuthorization: {
          ...authorization,
          maximumCalls: 2,
        },
      }),
    );

    expect(result.status).toBe("EXECUTION_BLOCKED");
    expect(result.auditTimeline.at(-1)?.type).toBe("WORKFLOW_BLOCKED");
  });

  it("returns the completed result for a duplicate run without creating a second order", async () => {
    const purchaseOrders = new MockPurchaseOrderAdapter();
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      purchaseOrders,
      () => new Date("2026-08-21T09:42:00Z"),
    );
    const input = workflowInput();

    const first = await workflow.run(input);
    const duplicate = await workflow.run(input);

    expect(duplicate.purchaseOrder?.purchaseOrderId).toBe(
      first.purchaseOrder?.purchaseOrderId,
    );
    expect(purchaseOrders.createdOrders).toHaveLength(1);
  });

  it("creates exactly one purchase order for a repeated idempotency key", async () => {
    const purchaseOrders = new MockPurchaseOrderAdapter();
    const request = {
      idempotencyKey: "wf-1:purchase-order",
      workflowId: "wf-1",
      supplierId: "supplier-de-01",
      supplierName: "NordWerk Supply",
      sku: "CF-220",
      quantity: 8,
      unitPriceEur: 42,
      totalPriceEur: 336,
      deliveryAt: "2026-08-27T10:00:00+02:00",
      policyVersion: policy.version,
    };

    const first = await purchaseOrders.createPurchaseOrder(request);
    const duplicate = await purchaseOrders.createPurchaseOrder(request);

    expect(duplicate.purchaseOrderId).toBe(first.purchaseOrderId);
    expect(purchaseOrders.createdOrders).toHaveLength(1);
  });

  it("fails closed when synthetic purchase-order creation fails", async () => {
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      {
        async createPurchaseOrder() {
          throw new Error("Synthetic PO adapter unavailable");
        },
      },
      () => new Date("2026-08-21T09:42:00Z"),
    );

    const result = await workflow.run(workflowInput());

    expect(result.status).toBe("FAILED");
    expect(result.workflowState).toBe("FAILED");
    expect(result.purchaseOrder).toBeNull();
    expect(result.proof).toBeNull();
    expect(result.auditTimeline.at(-1)?.type).toBe("WORKFLOW_FAILED");
  });

  it("honours cancellation before any supplier call or order", async () => {
    const store = new InMemoryWorkflowRunStore();
    store.cancel("wf-2026-081");
    const purchaseOrders = new MockPurchaseOrderAdapter();
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter(),
      purchaseOrders,
      () => new Date("2026-08-21T09:42:00Z"),
      undefined,
      store,
    );

    const result = await workflow.run(workflowInput());

    expect(result.workflowState).toBe("CANCELLED");
    expect(result.auditTimeline.at(-1)?.type).toBe("WORKFLOW_CANCELLED");
    expect(purchaseOrders.createdOrders).toHaveLength(0);
  });

  it("turns a missing terminal webhook into a controlled timeout and human review", async () => {
    const pendingTask = {
      callId: "call-pending",
      status: "queued" as const,
      taskCompleted: false,
      completionConfidence: null,
      structuredResult: null,
      evidence: [],
      fieldEvidence: {},
      schemaValidation: { valid: false, issues: [] },
      outcome: "INCOMPLETE" as const,
    };
    const supplier = suppliers[0];
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter({ [supplier.supplierId]: pendingTask }),
      new MockPurchaseOrderAdapter(),
      () => new Date("2026-08-21T09:42:00Z"),
      undefined,
      new InMemoryWorkflowRunStore(),
      { maximumAttempts: 1, maximumPolls: 2, timeoutMs: 50, pollIntervalMs: 0, initialPollDelayMs: 0 },
      async () => {},
    );

    const result = await workflow.run(
      workflowInput({
        suppliers: [supplier],
        callAuthorization: {
          ...authorization,
          maximumCalls: 1,
          allowedSupplierIds: [supplier.supplierId],
          allowedPhoneNumbers: [supplier.phoneE164],
        },
      }),
    );

    expect(result.status).toBe("HUMAN_ESCALATION_REQUIRED");
    expect(result.workflowState).toBe("HUMAN_ESCALATION_REQUIRED");
    expect(result.auditTimeline.some(({ type }) => type === "CALL_TIMEOUT")).toBe(true);
    expect(result.decision?.rejectedOffers[0].offer.attemptCount).toBe(1);
  });

  it("preserves a real call ID when a later status poll times out", async () => {
    let starts = 0;
    const supplier = suppliers[0];
    const adapter: SupplierCallingPort = {
      async startSupplierCall() {
        starts += 1;
        return {
          callId: "call-real-preserved",
          status: "queued",
          taskCompleted: false,
          completionConfidence: null,
          structuredResult: null,
          evidence: [],
          fieldEvidence: {},
          schemaValidation: { valid: false, issues: [] },
          outcome: "INCOMPLETE",
        };
      },
      async getSupplierCall() {
        throw new Error("CALL_TIMEOUT");
      },
    };
    const workflow = new ProcurementWorkflow(
      adapter,
      new MockPurchaseOrderAdapter(),
      () => new Date("2026-08-21T09:42:00Z"),
      undefined,
      new InMemoryWorkflowRunStore(),
      { maximumAttempts: 1, maximumPolls: 1, timeoutMs: 50, pollIntervalMs: 0, initialPollDelayMs: 0 },
      async () => {},
    );

    const result = await workflow.run(
      workflowInput({
        suppliers: [supplier],
        callAuthorization: {
          ...authorization,
          maximumCalls: 1,
          allowedSupplierIds: [supplier.supplierId],
          allowedPhoneNumbers: [supplier.phoneE164],
        },
      }),
    );

    const completed = result.auditTimeline.find(({ type }) => type === "CALL_COMPLETED");
    expect(starts).toBe(1);
    expect(completed?.evidence.callId).toBe("call-real-preserved");
    expect(completed?.evidence.outcome).toBe("TIMEOUT");
    expect(String(completed?.evidence.callId)).not.toContain("failed-");
  });

  it("retries a no-answer outcome once and then uses the completed quote", async () => {
    const baseAdapter = new MockCallEAdapter();
    let starts = 0;
    const flakyAdapter: SupplierCallingPort = {
      async startSupplierCall(request, callAuthorization) {
        starts += 1;
        const completed = await baseAdapter.startSupplierCall(
          request,
          callAuthorization,
        );
        return starts === 1
          ? {
              ...completed,
              status: "failed" as const,
              taskCompleted: false,
              structuredResult: null,
              fieldEvidence: {},
              schemaValidation: { valid: false, issues: [] },
              outcome: "NO_ANSWER" as const,
            }
          : completed;
      },
      getSupplierCall(callId) {
        return baseAdapter.getSupplierCall(callId);
      },
    };
    const supplier = suppliers[0];
    const workflow = new ProcurementWorkflow(
      flakyAdapter,
      new MockPurchaseOrderAdapter(),
      () => new Date("2026-08-21T09:42:00Z"),
      undefined,
      new InMemoryWorkflowRunStore(),
      { maximumAttempts: 2, maximumPolls: 1, timeoutMs: 50, pollIntervalMs: 0, initialPollDelayMs: 0 },
      async () => {},
    );

    const result = await workflow.run(
      workflowInput({
        suppliers: [supplier],
        callAuthorization: {
          ...authorization,
          maximumCalls: 2,
          allowedSupplierIds: [supplier.supplierId],
          allowedPhoneNumbers: [supplier.phoneE164],
        },
      }),
    );

    expect(starts).toBe(2);
    expect(result.status).toBe("ORDER_CREATED");
    expect(result.decision?.selectedOffer?.attemptCount).toBe(2);
    expect(
      result.auditTimeline.some(({ type }) => type === "CALL_RETRY_SCHEDULED"),
    ).toBe(true);
  });

  it("preserves synthetic RFQ routing from workflow planning through the audit", async () => {
    const baseAdapter = new MockCallEAdapter();
    let capturedRequest: SupplierCallRequest | null = null;
    const routing = {
      kind: "SYNTHETIC_SUPPLIER_SIMULATOR" as const,
      rfqId: "RFQ-DE-081",
      routingCode: "281001",
      supplierProfileId: "DE_SUPPLIER" as const,
      datasetVersion: "synthetic-suppliers-2026-08-v1",
    };
    const supplier = { ...suppliers[0], syntheticRouting: routing };
    const adapter: SupplierCallingPort = {
      async startSupplierCall(callRequest, callAuthorization) {
        capturedRequest = structuredClone(callRequest);
        return baseAdapter.startSupplierCall(callRequest, callAuthorization);
      },
      getSupplierCall(callId) {
        return baseAdapter.getSupplierCall(callId);
      },
    };
    const workflow = new ProcurementWorkflow(
      adapter,
      new MockPurchaseOrderAdapter(),
      () => new Date("2026-08-21T09:42:00Z"),
    );

    const result = await workflow.run(
      workflowInput({
        suppliers: [supplier],
        callAuthorization: {
          ...authorization,
          maximumCalls: 1,
          allowedSupplierIds: [supplier.supplierId],
          allowedPhoneNumbers: [supplier.phoneE164],
        },
      }),
    );

    expect(capturedRequest).toMatchObject({ syntheticRouting: routing });
    expect(
      result.auditTimeline.find(({ type }) => type === "CALL_COMPLETED")?.evidence,
    ).toMatchObject({
      counterpartyMode: "SYNTHETIC_SUPPLIER_SIMULATOR",
      rfqId: "RFQ-DE-081",
      supplierProfileId: "DE_SUPPLIER",
      datasetVersion: "synthetic-suppliers-2026-08-v1",
    });
  });
});
