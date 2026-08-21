import { supplierCallResultSchema } from "./resultSchema";
import { validateSupplierCallResult } from "./validateStructuredResult";
import { CallSafetyError, validateCallAuthorization } from "./safety";
import type {
  CallAuthorization,
  SupplierCallingPort,
  SupplierCallRequest,
  SupplierCallStructuredResult,
  SupplierCallTask,
} from "./types";

type FetchLike = typeof fetch;

type CallEApiConfig = {
  apiKey: string;
  baseUrl?: string;
  realCallsEnabled?: boolean;
  fetchImplementation?: FetchLike;
  syntheticSupplierSimulator?: {
    enabled: boolean;
    phoneE164: string;
    allowedProfileIds: Array<
      "DE_SUPPLIER" | "FR_SUPPLIER" | "PL_SUPPLIER"
    >;
  };
};

type CallEApiResponse = {
  id?: string;
  call_id?: string;
  status?: SupplierCallTask["status"];
  task_completed?: boolean;
  completion_confidence?: { score?: number } | number | null;
  structured_result?: SupplierCallStructuredResult | null;
  evidence?: string[];
  field_evidence?: SupplierCallTask["fieldEvidence"];
  outcome?: SupplierCallTask["outcome"];
};

function mapTask(response: CallEApiResponse): SupplierCallTask {
  const callId = response.call_id ?? response.id;
  if (!callId) throw new Error("CALL-E response did not include a call ID");

  const rawConfidence = response.completion_confidence;
  const completionConfidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : rawConfidence?.score ?? null;
  const validation = validateSupplierCallResult(response.structured_result);

  return {
    callId,
    status: response.status ?? "queued",
    taskCompleted: response.task_completed ?? false,
    completionConfidence,
    structuredResult: validation.result,
    evidence: response.evidence ?? [],
    fieldEvidence: response.field_evidence ?? {},
    schemaValidation: {
      valid: validation.valid,
      issues: validation.issues,
    },
    outcome:
      response.outcome ??
      (response.task_completed
        ? "ANSWERED"
        : response.status === "failed"
          ? "FAILED"
          : "INCOMPLETE"),
  };
}

export class CallEApiAdapter implements SupplierCallingPort {
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchLike;
  private readonly startedCallsByWorkflow = new Map<string, number>();

  constructor(private readonly config: CallEApiConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.heycall-e.com";
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  async startSupplierCall(
    request: SupplierCallRequest,
    authorization: CallAuthorization,
  ): Promise<SupplierCallTask> {
    if (!this.config.realCallsEnabled) {
      throw new CallSafetyError(
        "Real CALL-E calls are disabled",
        "REAL_CALLS_DISABLED",
      );
    }

    validateCallAuthorization(request, authorization);
    this.validateSyntheticTarget(request);

    const callsAlreadyStarted =
      this.startedCallsByWorkflow.get(request.workflowId) ?? 0;

    if (callsAlreadyStarted >= authorization.maximumCalls) {
      throw new CallSafetyError(
        "Workflow call limit has been reached",
        "CALL_LIMIT_INVALID",
      );
    }

    const syntheticRouting = request.syntheticRouting;
    const routingInstructions = syntheticRouting
      ? [
          "The recipient is a deterministic synthetic supplier test harness, not a real company.",
          `At the initial English routing prompt, clearly say: routing code ${syntheticRouting.routingCode.split("").join(" ")}.`,
          "Wait for the test harness to confirm the target language, then continue in the requested conversation locale.",
          `The expected synthetic profile is ${syntheticRouting.supplierProfileId} and RFQ is ${syntheticRouting.rfqId}.`,
        ]
      : [];
    const languageInstruction = syntheticRouting
      ? `Except for the short English routing phrase, use ${request.locale} throughout the supplier conversation.`
      : `Use ${request.locale} throughout the conversation.`;
    const task = [
      `Call the approved supplier ${request.supplierName}.`,
      `Immediately disclose that you are an AI procurement assistant calling for a fictional test organization.`,
      `State that the call only requests availability information and cannot create a binding order.`,
      ...routingInstructions,
      languageInstruction,
      `Confirm availability of ${request.requestedQuantity} units of SKU ${request.sku} before ${request.requiredBy}.`,
      "Collect unit price, currency, earliest delivery, offer validity, and any changed commercial terms.",
      "If the recipient opts out, stop the conversation and record the opt-out.",
      "Do not collect payment data, credentials, access codes, or unrelated personal information.",
    ].join(" ");

    const response = await this.fetchImplementation(`${this.baseUrl}/v1/calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${request.workflowId}:${request.supplierId}:attempt:${request.attemptNumber}`,
      },
      body: JSON.stringify({
        task,
        recipients: [
          {
            phones: [request.phoneE164],
            region: request.region,
            locale: request.locale,
          },
        ],
        recipient_result_schema: supplierCallResultSchema,
        metadata: {
          workflow_run_id: request.workflowId,
          supplier_id: request.supplierId,
          purpose: "synthetic-procurement-demo",
          counterparty_mode: syntheticRouting
            ? "synthetic-supplier-simulator"
            : "approved-supplier",
          ...(syntheticRouting
            ? {
                synthetic_rfq_id: syntheticRouting.rfqId,
                synthetic_routing_code: syntheticRouting.routingCode,
                synthetic_supplier_profile: syntheticRouting.supplierProfileId,
                synthetic_dataset_version: syntheticRouting.datasetVersion,
              }
            : {}),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `CALL-E call creation failed with HTTP ${response.status}`,
      );
    }

    this.startedCallsByWorkflow.set(
      request.workflowId,
      callsAlreadyStarted + 1,
    );

    return mapTask((await response.json()) as CallEApiResponse);
  }

  private validateSyntheticTarget(request: SupplierCallRequest): void {
    const simulator = this.config.syntheticSupplierSimulator;
    const routing = request.syntheticRouting;
    if (!routing) {
      if (simulator && request.phoneE164 === simulator.phoneE164) {
        throw new CallSafetyError(
          "Synthetic simulator number requires explicit routing context",
          "SYNTHETIC_ROUTING_REQUIRED",
        );
      }
      return;
    }
    if (!simulator?.enabled) {
      throw new CallSafetyError(
        "Synthetic supplier simulator calls are disabled",
        "SYNTHETIC_SIMULATOR_DISABLED",
      );
    }
    if (request.phoneE164 !== simulator.phoneE164) {
      throw new CallSafetyError(
        "Synthetic supplier routing may only use the configured Connect test number",
        "SYNTHETIC_SIMULATOR_NUMBER_MISMATCH",
      );
    }
    if (!simulator.allowedProfileIds.includes(routing.supplierProfileId)) {
      throw new CallSafetyError(
        "Synthetic supplier profile is not allowlisted",
        "SYNTHETIC_PROFILE_NOT_ALLOWED",
      );
    }
    if (
      routing.kind !== "SYNTHETIC_SUPPLIER_SIMULATOR" ||
      routing.rfqId.length === 0 ||
      !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(routing.rfqId) ||
      !/^\d{6}$/.test(routing.routingCode) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(routing.datasetVersion)
    ) {
      throw new CallSafetyError(
        "Synthetic supplier routing context is invalid",
        "SYNTHETIC_ROUTING_INVALID",
      );
    }
  }

  async getSupplierCall(callId: string): Promise<SupplierCallTask> {
    const response = await this.fetchImplementation(
      `${this.baseUrl}/v1/calls/${encodeURIComponent(callId)}`,
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `CALL-E call lookup failed with HTTP ${response.status}`,
      );
    }

    return mapTask((await response.json()) as CallEApiResponse);
  }
}
