import { managerEscalationResultSchema } from "./resultSchema";
import { ManagerEscalationSafetyError, validateManagerEscalationAuthorization } from "./safety";
import type {
  ManagerEscalationAuthorization,
  ManagerEscalationPort,
  ManagerEscalationRequest,
  ManagerEscalationTask,
} from "./types";
import { validateManagerEscalationResult } from "./validateManagerEscalation";

type FetchLike = typeof fetch;

type Config = {
  apiKey: string;
  baseUrl?: string;
  realCallsEnabled?: boolean;
  fetchImplementation?: FetchLike;
};

export class CallEManagerEscalationAdapter implements ManagerEscalationPort {
  private readonly fetchImplementation: FetchLike;
  private readonly baseUrl: string;
  private readonly tasksByIdempotencyKey = new Map<string, ManagerEscalationTask>();
  private readonly usedSessions = new Set<string>();

  constructor(private readonly config: Config) {
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.baseUrl = config.baseUrl ?? "https://api.heycall-e.com";
  }

  async startManagerEscalation(
    request: ManagerEscalationRequest,
    authorization: ManagerEscalationAuthorization,
  ): Promise<ManagerEscalationTask> {
    if (!this.config.realCallsEnabled) {
      throw new ManagerEscalationSafetyError("Real manager calls are disabled", "REAL_CALLS_DISABLED");
    }
    validateManagerEscalationAuthorization(request, authorization);
    const existing = this.tasksByIdempotencyKey.get(request.idempotencyKey);
    if (existing) return structuredClone(existing);
    if (this.usedSessions.has(request.sessionId)) {
      throw new Error("Judge session call limit has already been consumed");
    }

    const rejectionSummary = request.context.rejectedOffers
      .map(({ supplierName, failedChecks, requiresHumanChecks }) =>
        `${supplierName}: ${[...failedChecks, ...requiresHumanChecks].join(", ")}`,
      )
      .join("; ");
    const task = [
      "Immediately disclose that you are StockGuard, an AI procurement system.",
      `State that you act for the fictional company ${request.context.organizationName} and that all data and orders are synthetic.`,
      `Explain that ${request.context.requiredQuantity} units of ${request.context.sku} are required before ${request.context.stockoutAt}.`,
      `Explain why no offer qualified: ${rejectionSummary}.`,
      "Collect exactly one bounded operational response from the allowed decision enum.",
      "Never change budget, policy, supplier approval, legal terms, or create an order during the call.",
      "If a restricted action is requested, explain that authenticated portal approval is required and classify it accordingly.",
      "Stop immediately if the recipient opts out.",
    ].join(" ");

    const response = await this.fetchImplementation(`${this.baseUrl}/v1/calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify({
        task,
        recipients: [{ phones: [request.phoneE164], locale: request.locale }],
        recipient_result_schema: managerEscalationResultSchema,
        metadata: {
          workflow_run_id: request.runId,
          judge_session_id: request.sessionId,
          purpose: "synthetic-manager-escalation-demo",
        },
      }),
    });
    if (!response.ok) throw new Error(`CALL-E manager escalation failed with HTTP ${response.status}`);

    const payload = (await response.json()) as Record<string, unknown>;
    const validation = validateManagerEscalationResult(payload.structured_result);
    const callId = typeof payload.call_id === "string" ? payload.call_id : typeof payload.id === "string" ? payload.id : null;
    if (!callId) throw new Error("CALL-E response did not include a call ID");
    const completed = payload.task_completed === true;
    const mapped: ManagerEscalationTask = {
      callId,
      status: completed ? "completed" : "queued",
      outcome: completed ? "ANSWERED" : "FAILED",
      taskCompleted: completed,
      structuredResult: validation.result,
      evidence: Array.isArray(payload.evidence) ? payload.evidence.filter((item): item is string => typeof item === "string") : [],
      fieldEvidence:
        typeof payload.field_evidence === "object" && payload.field_evidence !== null
          ? (payload.field_evidence as ManagerEscalationTask["fieldEvidence"])
          : {},
      schemaValidation: { valid: validation.valid, issues: validation.issues },
    };
    this.usedSessions.add(request.sessionId);
    this.tasksByIdempotencyKey.set(request.idempotencyKey, mapped);
    return structuredClone(mapped);
  }
}
