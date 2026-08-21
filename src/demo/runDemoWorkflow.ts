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
  ManagerEscalationWorkflow,
  MockManagerEscalationAdapter,
  type MockManagerResponse,
} from "../server/escalation";
import type { SupportedCallLocale } from "../server/calle";
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  syntheticSupplierProfiles,
  toMockSupplierResult,
  type SupplierProfileId,
  type SyntheticRfq,
} from "../server/supplier-simulator";
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

const demoClock = () => new Date("2026-08-21T10:30:00Z");

export type DemoCallOutcome =
  | "quote"
  | "no-answer"
  | "voicemail"
  | "incomplete"
  | "late"
  | "expensive"
  | "missing-webhook"
  | "connection-lost"
  | "insufficient"
  | "terms-changed";

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

export const managerEscalationScenario: DemoScenario = {
  requiredQuantity: 8,
  budgetEur: 500,
  stockoutAt: "2026-08-28T12:00:00+02:00",
  supplierOutcomes: {
    "supplier-de-01": "insufficient",
    "supplier-fr-01": "late",
    "supplier-pl-01": "terms-changed",
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

function failedTask(
  status: "failed" | "completed",
  outcome: "NO_ANSWER" | "VOICEMAIL" | "FAILED",
  evidence: string,
): SupplierCallTask {
  return {
    callId: "configured-at-runtime",
    status,
    taskCompleted: false,
    completionConfidence: 0,
    structuredResult: null,
    evidence: [evidence],
    fieldEvidence: {},
    schemaValidation: {
      valid: false,
      issues: [{ field: "$", message: "No structured quote was received" }],
    },
    outcome,
  };
}

function pendingTask(): SupplierCallTask {
  return {
    callId: "configured-at-runtime",
    status: "queued",
    taskCompleted: false,
    completionConfidence: null,
    structuredResult: null,
    evidence: ["Call accepted but no terminal webhook was received"],
    fieldEvidence: {},
    schemaValidation: {
      valid: false,
      issues: [{ field: "$", message: "Awaiting terminal CALL-E result" }],
    },
    outcome: "INCOMPLETE",
  };
}

function scenarioResults(scenario: DemoScenario): Record<string, MockSupplierResult | SupplierCallTask> {
  return Object.fromEntries(
    Object.entries(baseResults).map(([supplierId, original]) => {
      const outcome = scenario.supplierOutcomes[supplierId] ?? "quote";
      if (outcome === "no-answer") return [supplierId, failedTask("failed", "NO_ANSWER", "No answer")];
      if (outcome === "voicemail") return [supplierId, failedTask("completed", "VOICEMAIL", "Voicemail detected; no quote collected")];
      if (outcome === "connection-lost") return [supplierId, failedTask("failed", "FAILED", "Connection was lost before a quote was confirmed")];
      if (outcome === "missing-webhook") return [supplierId, pendingTask()];

      const result: MockSupplierResult = { ...original };
      if (supplierId === "supplier-de-01") {
        result.availableQuantity = scenario.primaryOfferQuantity;
        result.unitPrice = scenario.primaryOfferUnitPriceEur;
      }
      if (outcome === "incomplete") result.unitPrice = null;
      if (outcome === "insufficient") result.availableQuantity = Math.max(0, scenario.requiredQuantity - 2);
      if (outcome === "late") {
        result.availableQuantity = scenario.requiredQuantity;
        result.deliveryAt = "2026-09-05T10:00:00+02:00";
      }
      if (outcome === "expensive") result.unitPrice = result.currency === "PLN" ? 250 : 60;
      if (outcome === "terms-changed") {
        result.availableQuantity = scenario.requiredQuantity;
        result.deliveryAt = "2026-08-27T10:00:00+02:00";
        result.commercialTermsChanged = true;
      }
      return [supplierId, result];
    }),
  );
}

const simulatorProfileBySupplier: Record<string, SupplierProfileId> = {
  "supplier-de-01": "DE_SUPPLIER",
  "supplier-fr-01": "FR_SUPPLIER",
  "supplier-pl-01": "PL_SUPPLIER",
};

async function supplierSimulatorResults(
  input: WorkflowInput,
  requestedQuantity: number,
): Promise<Record<string, MockSupplierResult>> {
  const rfqs: SyntheticRfq[] = input.suppliers.map((supplier) => {
    if (!supplier.syntheticRouting) {
      throw new Error("Synthetic supplier demo requires explicit RFQ routing");
    }
    return {
      runId: input.workflowId,
      rfqId: supplier.syntheticRouting.rfqId,
      routingCode: supplier.syntheticRouting.routingCode,
      profileId: supplier.syntheticRouting.supplierProfileId,
      datasetVersion: supplier.syntheticRouting.datasetVersion,
      sku: input.inventory.sku,
      requestedQuantity,
      requiredBy: input.inventory.stockoutAt,
      expiresAt: "2026-08-21T11:30:00Z",
    };
  });
  const simulator = new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(undefined, rfqs),
    demoClock,
  );
  return Object.fromEntries(
    await Promise.all(
      rfqs.map(async (rfq) => {
        const response = await simulator.respond({
          intent: "GetSupplierQuote",
          rfqId: rfq.rfqId,
          profileId: rfq.profileId,
        });
        return [response.quote.supplierId, toMockSupplierResult(response.quote)];
      }),
    ),
  );
}

function createInput(
  autonomousExecutionEnabled: boolean,
  scenario: DemoScenario,
): WorkflowInput {
  const workflowSequence = Date.now();
  const workflowId = `wf-demo-${workflowSequence}`;
  const runtimeSuppliers = suppliers.map((supplier, index) => {
    const profileId = simulatorProfileBySupplier[supplier.supplierId];
    const routingCode = `${index + 1}${String(workflowSequence % 100_000).padStart(5, "0")}`;
    return {
      ...supplier,
      syntheticRouting: {
        kind: "SYNTHETIC_SUPPLIER_SIMULATOR" as const,
        rfqId: `RFQ-${supplier.region}-${workflowId}`,
        routingCode,
        supplierProfileId: profileId,
        datasetVersion: syntheticSupplierProfiles[profileId].datasetVersion,
      },
    };
  });

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
    suppliers: runtimeSuppliers,
    callAuthorization: {
      workflowId,
      approvedBy: "demo-operator",
      approvedAt: "2026-08-21T09:00:00Z",
      expiresAt: "2099-08-21T10:00:00Z",
      maximumCalls: 3,
      allowedSupplierIds: runtimeSuppliers.map(({ supplierId }) => supplierId),
      allowedPhoneNumbers: runtimeSuppliers.map(({ phoneE164 }) => phoneE164),
    },
    procurementPolicy: {
      ...policy,
      autonomousOrderLimitEur: scenario.budgetEur,
    },
    exchangeRates,
    autonomousExecutionEnabled,
  };
}

async function signWorkflowResult(
  result: WorkflowResult,
  input: WorkflowInput,
): Promise<WorkflowResult> {
  if (!result.proof || !result.decision) return result;
  const allOffers = [
    ...(result.decision.selectedOffer ? [result.decision.selectedOffer] : []),
    ...result.decision.rejectedOffers.map(({ offer }) => offer),
  ];
  const offerHashes = Object.fromEntries(
    await Promise.all(
      allOffers.map(async (offer) => [offer.supplierId, await sha256(offer)]),
    ),
  );
  const evidenceHashes = Object.fromEntries(
    await Promise.all(
      allOffers.map(async (offer) => [offer.supplierId, await sha256(offer.evidenceByField)]),
    ),
  );
  const auditChain = await createAuditChain(result.auditTimeline);

  result.signedProof = await createSignedDecisionProof({
    workflowId: result.workflowId,
    generatedAt: result.auditTimeline.at(-1)?.at ?? new Date().toISOString(),
    policyVersion: input.procurementPolicy.version,
    policyHash: await sha256(input.procurementPolicy),
    offerHashes,
    evidenceHashes,
    selectedSupplierId: result.proof.selectedSupplierId,
    selectedOfferId: result.proof.selectedOfferId,
    passedChecks: result.proof.passedChecks,
    rejectedSuppliers: result.decision.rejectedOffers.map(({ offer, validation }) => ({
      supplierId: offer.supplierId,
      failedChecks: validation.failedCheckIds,
      requiresHumanChecks: validation.humanReviewCheckIds,
    })),
    ruleTrace: result.proof.ruleTrace,
    orderValueEur: result.proof.orderValueEur,
    managerEscalation: result.managerEscalation
      ? {
          callIdHash: await sha256(result.managerEscalation.callId),
          responseHash: await sha256({
            rawDecision: result.managerEscalation.rawDecision,
            effectiveDecision: result.managerEscalation.effectiveDecision,
            preferredContactAt: result.managerEscalation.preferredContactAt,
            restrictedActionsRequested: result.managerEscalation.restrictedActionsRequested,
            summary: result.managerEscalation.summary,
          }),
          evidenceHash: await sha256(result.managerEscalation.evidenceExcerpt),
          rawDecision: result.managerEscalation.rawDecision,
          effectiveDecision: result.managerEscalation.effectiveDecision,
          preferredContactAt: result.managerEscalation.preferredContactAt,
          restrictedActionsRequested: result.managerEscalation.restrictedActionsRequested,
          outcome: result.managerEscalation.outcome,
          policyChanged: false,
          orderCreated: false,
        }
      : null,
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

export async function runDemoWorkflow(
  autonomousExecutionEnabled: boolean,
  scenario: DemoScenario = guidedScenario,
): Promise<WorkflowResult> {
  const workflow = new ProcurementWorkflow(
    new MockCallEAdapter(scenarioResults(scenario)),
    new MockPurchaseOrderAdapter(),
    demoClock,
  );

  const input = createInput(autonomousExecutionEnabled, scenario);
  const result = await workflow.run(input);
  return signWorkflowResult(result, input);
}

export async function runManagerEscalationDemo(
  response: MockManagerResponse,
  locale: SupportedCallLocale = "en-GB",
): Promise<WorkflowResult> {
  const input = createInput(true, managerEscalationScenario);
  const procurement = new ProcurementWorkflow(
    new MockCallEAdapter(
      await supplierSimulatorResults(
        input,
        managerEscalationScenario.requiredQuantity,
      ),
    ),
    new MockPurchaseOrderAdapter(),
    demoClock,
  );
  const baseResult = await procurement.run(input);
  const sessionId = `mock-judge-${input.workflowId}`;
  const phoneE164 = "+15550109999";
  const request = {
    runId: input.workflowId,
    sessionId,
    attemptNumber: 1 as const,
    idempotencyKey: `${sessionId}:${input.workflowId}:manager-escalation:attempt:1`,
    phoneE164,
    locale,
    consentConfirmed: true as const,
    context: {
      organizationName: "Northstar Manufacturing" as const,
      sku: input.inventory.sku,
      requiredQuantity: managerEscalationScenario.requiredQuantity,
      stockoutAt: input.inventory.stockoutAt,
      rejectedOffers: baseResult.decision?.rejectedOffers.map(({ offer, validation }) => ({
        supplierName: offer.supplierName,
        failedChecks: validation.failedCheckIds,
        requiresHumanChecks: validation.humanReviewCheckIds,
      })) ?? [],
    },
  };
  const escalation = new ManagerEscalationWorkflow(
    new MockManagerEscalationAdapter(response),
    demoClock,
  );
  const result = await escalation.run(baseResult, request, {
    sessionId,
    accessCodeVerifiedServerSide: true,
    issuedAt: "2026-08-21T10:00:00Z",
    expiresAt: "2099-08-21T10:15:00Z",
    allowedPhoneE164: phoneE164,
    maximumCalls: 1,
    consentRecordedAt: "2026-08-21T10:00:30Z",
    killSwitchActive: false,
  });
  return signWorkflowResult(result, input);
}

export async function runSupplierSimulatorDemo(): Promise<WorkflowResult> {
  const input = createInput(true, managerEscalationScenario);
  const workflow = new ProcurementWorkflow(
    new MockCallEAdapter(
      await supplierSimulatorResults(
        input,
        managerEscalationScenario.requiredQuantity,
      ),
    ),
    new MockPurchaseOrderAdapter(),
    demoClock,
  );
  return workflow.run(input);
}
