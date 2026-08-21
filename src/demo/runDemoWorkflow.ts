import type {
  ExchangeRatesToEur,
  ProcurementPolicy,
} from "../domain";
import {
  MockCallEAdapter,
  type MockSupplierResult,
  type SupplierCallTask,
} from "../server/calle";
import {
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
  appendWorkflowState,
  type SupplierContact,
  type WorkflowInput,
  type WorkflowResult,
} from "../server/workflow";
import {
  createAuditChain,
  createSignedDecisionProof,
  sha256,
} from "../security";

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

export type DemoCallOutcome =
  | "quote"
  | "no-answer"
  | "voicemail"
  | "incomplete"
  | "late"
  | "expensive";

export type DemoScenario = {
  requiredQuantity: number;
  budgetEur: number;
  stockoutAt: string;
  supplierOutcomes: Record<string, DemoCallOutcome>;
  primaryOfferQuantity: number;
  primaryOfferUnitPriceEur: number;
};

export const guidedScenario: DemoScenario = {
  requiredQuantity: 8,
  budgetEur: 500,
  stockoutAt: "2026-08-28T12:00:00+02:00",
  supplierOutcomes: {
    "supplier-de-01": "quote",
    "supplier-fr-01": "quote",
    "supplier-pl-01": "late",
  },
  primaryOfferQuantity: 8,
  primaryOfferUnitPriceEur: 42,
};

const baseResults: Record<string, MockSupplierResult> = {
  "supplier-de-01": {
    skuConfirmed: true,
    availableQuantity: 8,
    unitPrice: 42,
    currency: "EUR",
    deliveryAt: "2026-08-27T10:00:00+02:00",
    offerValidUntil: "2026-08-22T16:00:00+02:00",
    commercialTermsChanged: false,
    optOutRequested: false,
    notes: "Full quantity available before the predicted stockout.",
  },
  "supplier-fr-01": {
    skuConfirmed: true,
    availableQuantity: 6,
    unitPrice: 38,
    currency: "EUR",
    deliveryAt: "2026-08-26T12:00:00+02:00",
    offerValidUntil: "2026-08-22T17:00:00+02:00",
    commercialTermsChanged: false,
    optOutRequested: false,
    notes: "Only partial quantity is available.",
  },
  "supplier-pl-01": {
    skuConfirmed: true,
    availableQuantity: 8,
    unitPrice: 158,
    currency: "PLN",
    deliveryAt: "2026-08-31T10:00:00+02:00",
    offerValidUntil: "2026-08-23T12:00:00+02:00",
    commercialTermsChanged: false,
    optOutRequested: false,
    notes: "Full quantity is available, but delivery is after stockout.",
  },
};

function failedTask(status: "failed" | "completed", evidence: string): SupplierCallTask {
  return {
    callId: "configured-at-runtime",
    status,
    taskCompleted: false,
    completionConfidence: 0,
    structuredResult: null,
    evidence: [evidence],
  };
}

function scenarioResults(scenario: DemoScenario): Record<string, MockSupplierResult | SupplierCallTask> {
  return Object.fromEntries(
    Object.entries(baseResults).map(([supplierId, original]) => {
      const outcome = scenario.supplierOutcomes[supplierId] ?? "quote";
      if (outcome === "no-answer") return [supplierId, failedTask("failed", "No answer")];
      if (outcome === "voicemail") return [supplierId, failedTask("completed", "Voicemail detected; no quote collected")];

      const result: MockSupplierResult = { ...original };
      if (supplierId === "supplier-de-01") {
        result.availableQuantity = scenario.primaryOfferQuantity;
        result.unitPrice = scenario.primaryOfferUnitPriceEur;
      }
      if (outcome === "incomplete") result.unitPrice = null;
      if (outcome === "late") result.deliveryAt = "2026-09-05T10:00:00+02:00";
      if (outcome === "expensive") result.unitPrice = 60;
      return [supplierId, result];
    }),
  );
}

function createInput(
  autonomousExecutionEnabled: boolean,
  scenario: DemoScenario,
): WorkflowInput {
  const workflowId = `wf-demo-${Date.now()}`;

  return {
    workflowId,
    inventory: {
      sku: "CF-220",
      onHand: 8,
      confirmedDemand: scenario.requiredQuantity + 6,
      inboundConfirmed: 0,
      safetyStock: 2,
      stockoutAt: scenario.stockoutAt,
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
    procurementPolicy: {
      ...policy,
      autonomousOrderLimitEur: scenario.budgetEur,
    },
    exchangeRates,
    autonomousExecutionEnabled,
  };
}

export async function runDemoWorkflow(
  autonomousExecutionEnabled: boolean,
  scenario: DemoScenario = guidedScenario,
): Promise<WorkflowResult> {
  const workflow = new ProcurementWorkflow(
    new MockCallEAdapter(scenarioResults(scenario)),
    new MockPurchaseOrderAdapter(),
  );

  const input = createInput(autonomousExecutionEnabled, scenario);
  const result = await workflow.run(input);

  if (!result.proof || !result.decision?.selectedOffer || !result.decision.validation) {
    return result;
  }

  const allOffers = [
    result.decision.selectedOffer,
    ...result.decision.rejectedOffers.map(({ offer }) => offer),
  ];
  const offerHashes = Object.fromEntries(
    await Promise.all(
      allOffers.map(async (offer) => [offer.supplierId, await sha256(offer)]),
    ),
  );
  const auditChain = await createAuditChain(result.auditTimeline);

  result.signedProof = await createSignedDecisionProof({
    workflowId: result.workflowId,
    generatedAt: result.auditTimeline.at(-1)?.at ?? new Date().toISOString(),
    policyVersion: input.procurementPolicy.version,
    policyHash: await sha256(input.procurementPolicy),
    offerHashes,
    selectedSupplierId: result.proof.selectedSupplierId,
    selectedOfferId: result.proof.selectedOfferId,
    passedChecks: result.proof.passedChecks,
    rejectedSuppliers: result.decision.rejectedOffers.map(({ offer, validation }) => ({
      supplierId: offer.supplierId,
      failedChecks: validation.failedCheckIds,
    })),
    orderValueEur: result.proof.orderValueEur,
    auditChain,
  });
  result.stateHistory = appendWorkflowState(
    result.stateHistory,
    "PROOF_SIGNED",
    "Decision proof signed with the explicit demo signer",
    new Date().toISOString(),
  );
  result.workflowState = "PROOF_SIGNED";

  return result;
}
