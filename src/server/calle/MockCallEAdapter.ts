import type {
  CallAuthorization,
  SupplierCallingPort,
  SupplierCallRequest,
  SupplierCallStructuredResult,
  SupplierCallTask,
} from "./types";
import { validateCallAuthorization } from "./safety";
import { validateSupplierCallResult } from "./validateStructuredResult";

export type MockSupplierResult = Omit<
  SupplierCallStructuredResult,
  "supplierId" | "language"
>;

const mockResults: Record<string, MockSupplierResult> = {
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

export class MockCallEAdapter implements SupplierCallingPort {
  private readonly tasks = new Map<string, SupplierCallTask>();

  constructor(
    private readonly results: Record<string, MockSupplierResult | SupplierCallTask> = mockResults,
  ) {}

  async startSupplierCall(
    request: SupplierCallRequest,
    authorization: CallAuthorization,
  ): Promise<SupplierCallTask> {
    validateCallAuthorization(request, authorization);

    const result = this.results[request.supplierId];
    if (!result) throw new Error(`No mock result for ${request.supplierId}`);

    const callId = `mock-${request.workflowId}-${request.supplierId}`;
    if ("callId" in result) {
      const configuredTask = { ...result, callId };
      this.tasks.set(callId, configuredTask);
      return configuredTask;
    }
    const structuredResult: SupplierCallStructuredResult = {
      supplierId: request.supplierId,
      language: request.locale,
      ...result,
    };
    const validation = validateSupplierCallResult(structuredResult);
    const evidenceFields = [
      "skuConfirmed",
      "availableQuantity",
      "unitPrice",
      "currency",
      "deliveryAt",
      "offerValidUntil",
      "commercialTermsChanged",
    ] as const;
    const fieldEvidence = Object.fromEntries(
      evidenceFields.filter((field) => structuredResult[field] !== null)
        .map((field) => [
          field,
          {
            field,
            source: "transcript" as const,
            excerpt: `Synthetic transcript evidence confirms ${field}: ${String(structuredResult[field])}`,
            verified: true,
          },
        ]),
    );
    const task: SupplierCallTask = {
      callId,
      status: "completed",
      taskCompleted: true,
      completionConfidence: 0.95,
      structuredResult: validation.result,
      evidence: [
        "AI disclosure acknowledged",
        "Supplier availability response captured",
        "No binding order was created during the call",
      ],
      fieldEvidence,
      schemaValidation: {
        valid: validation.valid,
        issues: validation.issues,
      },
    };

    this.tasks.set(callId, task);
    return task;
  }

  async getSupplierCall(callId: string): Promise<SupplierCallTask> {
    const task = this.tasks.get(callId);
    if (!task) throw new Error(`Unknown mock call ${callId}`);
    return task;
  }
}
