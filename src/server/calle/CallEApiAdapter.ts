import { supplierCallResultSchema } from "./resultSchema";
import {
  callFailureText,
  callIdFrom,
  evidenceAppearsInTranscript,
  recipientStructuredResult,
  userTranscript,
  type CallETaskSnapshot,
} from "./runtime";
import { validateSupplierCallResult } from "./validateStructuredResult";
import { CallSafetyError, validateCallAuthorization } from "./safety";
import type {
  CallAuthorization,
  SupplierCallingPort,
  SupplierCallRequest,
  SupplierCallTask,
  SupportedCallRegion,
} from "./types";

type FetchLike = typeof fetch;

export const DEFAULT_CALLE_HTTP_TIMEOUT_MS = 30_000;

type CallEApiConfig = {
  apiKey: string;
  baseUrl?: string;
  realCallsEnabled?: boolean;
  webhookUrl?: string;
  fetchImplementation?: FetchLike;
  httpTimeoutMs?: number;
  syntheticSupplierSimulator?: {
    enabled: boolean;
    phoneE164: string;
    region: SupportedCallRegion;
    allowedProfileIds: Array<
      "DE_SUPPLIER" | "FR_SUPPLIER" | "PL_SUPPLIER" | "EN_SUPPLIER"
    >;
    /**
     * Architecture A is already pinned to EN_SUPPLIER in Connect/Lex, so it
     * has no routing-code prompt. Later multi-profile simulator deployments may
     * opt back into the routing-code conversation.
     */
    routingMode?: "routing-code" | "fixed-qualification";
  };
};

function taskStatus(value: string | undefined): SupplierCallTask["status"] {
  switch (value) {
    case "queued":
    case "in_progress":
    case "completed":
    case "failed":
      return value;
    case "canceled":
    default:
      return "failed";
  }
}

function taskOutcome(
  response: CallETaskSnapshot,
  validation: ReturnType<typeof validateSupplierCallResult>,
  transcript: string,
): SupplierCallTask["outcome"] {
  const failure = callFailureText(response);
  if (failure.includes("no_answer") || failure.includes("no answer")) {
    return "NO_ANSWER";
  }
  if (failure.includes("voicemail") || failure.includes("answering machine")) {
    return "VOICEMAIL";
  }
  if (failure.includes("timeout") || failure.includes("timed out")) {
    return "TIMEOUT";
  }
  if (["failed", "canceled"].includes(response.status ?? "")) return "FAILED";
  if (response.status === "completed" && validation.valid && transcript.length > 0) {
    return "ANSWERED";
  }
  return "INCOMPLETE";
}

function mapTask(response: CallETaskSnapshot): SupplierCallTask {
  const callId = callIdFrom(response);
  if (!callId) throw new Error("CALL-E response did not include a call ID");

  const rawConfidence = response.completion_confidence;
  const completionConfidence =
    typeof rawConfidence === "number"
      ? rawConfidence
      : rawConfidence?.score ?? null;
  const validation = validateSupplierCallResult(
    recipientStructuredResult(response),
  );
  const transcript = userTranscript(response);
  const fieldEvidence = Object.fromEntries(
    Object.entries(validation.evidenceExcerpts).map(([field, excerpt]) => {
      const verified = evidenceAppearsInTranscript(excerpt, transcript);
      return [field, {
        field,
        source: verified ? "transcript" : "structured-result",
        excerpt,
        verified,
      }];
    }),
  ) as SupplierCallTask["fieldEvidence"];

  return {
    callId,
    status: taskStatus(response.status),
    taskCompleted: response.task_completed === true,
    completionConfidence,
    structuredResult: validation.result,
    evidence: Array.isArray(response.evidence)
      ? response.evidence.filter((item): item is string => typeof item === "string")
      : [],
    fieldEvidence,
    schemaValidation: {
      valid: validation.valid,
      issues: validation.issues,
    },
    outcome: taskOutcome(response, validation, transcript),
  };
}

export class CallEApiAdapter implements SupplierCallingPort {
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchLike;
  private readonly httpTimeoutMs: number;
  private readonly startedCallsByWorkflow = new Map<string, number>();

  constructor(private readonly config: CallEApiConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.heycall-e.com";
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.httpTimeoutMs = config.httpTimeoutMs ?? DEFAULT_CALLE_HTTP_TIMEOUT_MS;
    if (!Number.isFinite(this.httpTimeoutMs) || this.httpTimeoutMs <= 0) {
      throw new Error("CALL-E HTTP timeout must be positive");
    }
    if (config.webhookUrl) {
      const webhook = new URL(config.webhookUrl);
      if (webhook.protocol !== "https:") {
        throw new Error("CALL-E webhook URL must use HTTPS");
      }
    }
  }

  private async fetchTaskSnapshot(
    operation: "CREATE" | "POLL",
    path: string,
    init: RequestInit,
    callId?: string,
  ): Promise<{ snapshot: CallETaskSnapshot; elapsedMs: number }> {
    const controller = new AbortController();
    const startedAt = Date.now();
    let responseStatus: number | undefined;
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);

    try {
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      responseStatus = response.status;

      if (!response.ok) {
        console.warn(JSON.stringify({
          event: "CALLE_HTTP_NON_2XX",
          operation,
          ...(callId ? { callId } : {}),
          httpStatus: response.status,
          httpElapsedMs: Date.now() - startedAt,
        }));
        throw new Error(
          operation === "CREATE"
            ? `CALL-E call creation failed with HTTP ${response.status}`
            : `CALL-E call lookup failed with HTTP ${response.status}`,
        );
      }

      const snapshot = (await response.json()) as CallETaskSnapshot;
      return { snapshot, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      if (responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)) {
        throw error;
      }

      const category = controller.signal.aborted ? "TIMEOUT" : "NETWORK";
      console.warn(JSON.stringify({
        event: operation === "POLL" ? "CALLE_POLL_FAILED" : "CALLE_CALL_CREATE_FAILED",
        category,
        ...(callId ? { callId } : {}),
        httpElapsedMs: Date.now() - startedAt,
      }));

      if (controller.signal.aborted) {
        throw new Error("CALL_TIMEOUT", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
    const fixedQualification =
      syntheticRouting &&
      this.config.syntheticSupplierSimulator?.routingMode === "fixed-qualification";
    const routingInstructions = syntheticRouting
      ? fixedQualification
        ? [
            "The recipient is the approved English qualification supplier endpoint.",
            "This endpoint is already pinned to the English qualification profile; begin directly with the procurement qualification.",
            "Never speak internal RFQ IDs, workflow IDs, supplier profile IDs, dataset versions, metadata values, routing codes, or other internal routing identifiers to the recipient.",
          ]
        : [
            "The recipient is the approved multilingual supplier qualification endpoint.",
            `At the initial English routing prompt, clearly say: routing code ${syntheticRouting.routingCode.split("").join(" ")}.`,
            "Wait for the supplier endpoint to confirm the target language, then continue in the requested conversation locale.",
            `The expected synthetic profile is ${syntheticRouting.supplierProfileId} and RFQ is ${syntheticRouting.rfqId}.`,
          ]
      : [];
    const languageInstruction =
      syntheticRouting && !fixedQualification
        ? `Except for the short English routing phrase, use ${request.locale} throughout the supplier conversation.`
        : `Use ${request.locale} throughout the conversation.`;
    const openingInstructions = fixedQualification
      ? [
          "After hearing the complete greeting, naturally disclose that you are an AI procurement assistant calling on behalf of StockGuard.",
          "Explain that this is a non-binding supplier qualification call for availability and commercial information.",
          `Then naturally ask about availability for ${request.requestedQuantity} units of ${request.sku}.`,
        ]
      : [
          "After the greeting, disclose that you are an AI procurement assistant calling on behalf of StockGuard for a supplier qualification demo.",
          "State that the call only requests supplier availability and commercial information and cannot create a binding order.",
          `Confirm availability of ${request.requestedQuantity} units of SKU ${request.sku} before ${request.requiredBy}.`,
        ];
    const task = [
      `Call the approved supplier ${request.supplierName}.`,
      fixedQualification
        ? "The automated supplier speaks first. Its opening greeting ends with the exact phrase 'Please go ahead.' Do not begin your introduction or qualification question before you hear that phrase. If the recipient is speaking, never talk over them."
        : "The recipient will speak first. Do not begin speaking immediately when the call connects. Wait until the recipient has completed the full opening greeting and there is a brief pause before starting your introduction. If the recipient is speaking, never talk over them.",
      ...routingInstructions,
      languageInstruction,
      ...openingInstructions,
      ...(fixedQualification
        ? [
            `Refer to the requested product code naturally as '${request.sku}'. Never describe capitalization, punctuation, hyphens, or identifier formatting.`,
            "Collect only availability, available quantity, unit price, currency, earliest delivery, offer validity, and commercial or payment terms. Record an opt-out only if the recipient raises it.",
            "Track which qualification fields have already been explicitly confirmed. Do not request them again unless the recipient's answer was ambiguous or contradictory.",
            "Ensure commercial or payment terms are explicitly confirmed, but ask a focused follow-up only if they are not already clear.",
            "Once all required qualification facts are known, thank the recipient, say goodbye, and end the call.",
            "Do not ask open-ended closing questions such as 'anything else?'.",
            "Do not ask for supplier references, quote references, RFQ references, purchase-order references, or other identifiers.",
            "Do not reconfirm facts already clearly stated unless clarification is actually necessary.",
            "Do not use health-check questions such as 'Can you hear me?' or 'Are you there?' unless there has been a genuine extended silence.",
            "After a genuine misunderstanding or a 'Sorry' response, rephrase the current question once instead of restarting the qualification.",
          ]
        : [
            "Collect unit price, currency, earliest delivery, offer validity, and any changed commercial terms.",
            "If the recipient provides offer validity in the first response, do not ask for it again.",
            "Ask at least one follow-up question specifically about the commercial or payment terms.",
          ]),
      "If the recipient opts out, stop the conversation and record the opt-out.",
      "Do not collect payment data, credentials, access codes, or unrelated personal information.",
    ].join(" ");

    console.log(JSON.stringify({
      event: "CALLE_CALL_CREATE_STARTED",
      workflowId: request.workflowId,
      supplierId: request.supplierId,
      attemptNumber: request.attemptNumber,
    }));
    const { snapshot, elapsedMs } = await this.fetchTaskSnapshot("CREATE", "/v1/calls", {
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
            region:
              request.syntheticRouting && this.config.syntheticSupplierSimulator
                ? this.config.syntheticSupplierSimulator.region
                : request.region,
            locale: request.locale,
          },
        ],
        recipient_result_schema: supplierCallResultSchema,
        ...(this.config.webhookUrl
          ? { webhook_url: this.config.webhookUrl }
          : {}),
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

    this.startedCallsByWorkflow.set(
      request.workflowId,
      callsAlreadyStarted + 1,
    );

    const taskResult = mapTask(snapshot);
    console.log(JSON.stringify({
      event: "CALLE_CALL_CREATE_SUCCEEDED",
      workflowId: request.workflowId,
      callId: taskResult.callId,
      httpElapsedMs: elapsedMs,
    }));
    return taskResult;
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
    const { snapshot, elapsedMs } = await this.fetchTaskSnapshot(
      "POLL",
      `/v1/calls/${encodeURIComponent(callId)}`,
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      },
      callId,
    );
    const task = mapTask(snapshot);
    const terminal = ["completed", "failed"].includes(task.status);
    console.log(JSON.stringify({
      event: terminal ? "CALLE_TERMINAL_STATUS" : "CALLE_POLL_SUCCEEDED",
      callId: task.callId,
      status: task.status,
      ...(terminal ? { outcome: task.outcome } : {}),
      httpElapsedMs: elapsedMs,
    }));
    return task;
  }
}
