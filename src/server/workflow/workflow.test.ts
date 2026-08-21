import { describe, expect, it } from "vitest";
import type {
  ExchangeRatesToEur,
  ProcurementPolicy,
} from "../../domain";
import { MockCallEAdapter, type CallAuthorization } from "../calle";
import {
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
  type SupplierContact,
  type WorkflowInput,
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
    expect(result.proof?.passedChecks).toHaveLength(12);
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
});
