import type {
  ExchangeRatesToEur,
  ProcurementPolicy,
} from "../domain";
import { MockCallEAdapter } from "../server/calle/MockCallEAdapter";
import {
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
  type SupplierContact,
  type WorkflowInput,
  type WorkflowResult,
} from "../server/workflow";

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

const policy: ProcurementPolicy = {
  version: "PROCUREMENT-2026-08-v3",
  autonomousOrderLimitEur: 500,
  unitPriceCeilingEur: 45,
  minimumConfidence: 0.9,
  maximumAttempts: 2,
  approvedCurrencies: ["EUR", "PLN"],
};

const exchangeRates: ExchangeRatesToEur = {
  EUR: 1,
  PLN: 0.2329,
  USD: 0.86,
  GBP: 1.16,
};

function createInput(autonomousExecutionEnabled: boolean): WorkflowInput {
  const workflowId = "wf-2026-081";

  return {
    workflowId,
    inventory: {
      sku: "CF-220",
      onHand: 8,
      confirmedDemand: 14,
      inboundConfirmed: 0,
      safetyStock: 2,
      stockoutAt: "2026-08-28T12:00:00+02:00",
    },
    suppliers,
    callAuthorization: {
      workflowId,
      approvedBy: "demo-operator",
      approvedAt: "2026-08-21T09:00:00Z",
      expiresAt: "2099-08-21T10:00:00Z",
      maximumCalls: 3,
      allowedSupplierIds: suppliers.map(({ supplierId }) => supplierId),
      allowedPhoneNumbers: suppliers.map(({ phoneE164 }) => phoneE164),
    },
    procurementPolicy: policy,
    exchangeRates,
    autonomousExecutionEnabled,
  };
}

export async function runDemoWorkflow(
  autonomousExecutionEnabled: boolean,
): Promise<WorkflowResult> {
  const workflow = new ProcurementWorkflow(
    new MockCallEAdapter(),
    new MockPurchaseOrderAdapter(),
  );

  return workflow.run(createInput(autonomousExecutionEnabled));
}
