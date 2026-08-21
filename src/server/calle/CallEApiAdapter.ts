import { supplierCallResultSchema } from "./resultSchema";
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
};

type CallEApiResponse = {
  id?: string;
  call_id?: string;
  status?: SupplierCallTask["status"];
  task_completed?: boolean;
  completion_confidence?: { score?: number } | number | null;
  structured_result?: SupplierCallStructuredResult | null;
  evidence?: string[];
};

function mapTask(response: CallEApiResponse): SupplierCallTask {
  const callId = response.call_id ?? response.id;
  if (!callId) throw new Error("CALL-E response did not include a call ID");

  const rawConfidence = response.completion_confidence;
  const completionConfidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : rawConfidence?.score ?? null;

  return {
    callId,
    status: response.status ?? "queued",
    taskCompleted: response.task_completed ?? false,
    completionConfidence,
    structuredResult: response.structured_result ?? null,
    evidence: response.evidence ?? [],
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

    const callsAlreadyStarted =
      this.startedCallsByWorkflow.get(request.workflowId) ?? 0;

    if (callsAlreadyStarted >= authorization.maximumCalls) {
      throw new CallSafetyError(
        "Workflow call limit has been reached",
        "CALL_LIMIT_INVALID",
      );
    }

    const task = [
      `Call the approved supplier ${request.supplierName}.`,
      `Immediately disclose that you are an AI procurement assistant calling for a fictional test organization.`,
      `State that the call only requests availability information and cannot create a binding order.`,
      `Use ${request.locale} throughout the conversation.`,
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
        "Idempotency-Key": `${request.workflowId}:${request.supplierId}`,
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
