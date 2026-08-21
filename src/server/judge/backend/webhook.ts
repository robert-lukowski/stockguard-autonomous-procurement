import { canonicalize, sha256 } from "../../../security";
import {
  callFailureText,
  callIdFrom,
  evidenceAppearsInTranscript,
  parseCallEWebhookEnvelope,
  recipientStructuredResult,
  userTranscript,
  type CallETaskSnapshot,
} from "../../calle";
import {
  validateManagerEscalationResult,
  type ManagerEscalationTask,
} from "../../escalation";

export interface WebhookAuthenticityVerifier {
  verify(rawBody: string, headers: Record<string, string>): Promise<boolean>;
}

export class FailClosedWebhookAuthenticityVerifier
  implements WebhookAuthenticityVerifier
{
  async verify(): Promise<boolean> {
    return false;
  }
}

type FetchLike = typeof fetch;

/**
 * CALL-E does not currently sign webhooks. The documented origin-assurance
 * pattern is therefore: match CALL-E-Event-Id, then retrieve the terminal
 * call snapshot with the server-side API key and compare it to event.data.
 */
export class CallEWebhookAuthenticityVerifier
  implements WebhookAuthenticityVerifier
{
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchLike;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    fetchImplementation?: FetchLike;
  }) {
    this.baseUrl = config.baseUrl ?? "https://api.heycall-e.com";
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.apiKey = config.apiKey;
  }

  private readonly apiKey: string;

  async verify(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<boolean> {
    const envelope = parseCallEWebhookEnvelope(rawBody);
    if (!envelope || headers["call-e-event-id"] !== envelope.id) return false;
    const callId = callIdFrom(envelope.data);
    if (!callId || this.apiKey.length === 0) return false;

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/v1/calls/${encodeURIComponent(callId)}`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      if (!response.ok) return false;
      const authoritative = (await response.json()) as unknown;
      return canonicalize(authoritative) === canonicalize(envelope.data);
    } catch {
      return false;
    }
  }
}

export interface JudgeWebhookEventStore {
  claim(eventId: string, bodyHash: string): Promise<"ACCEPTED" | "DUPLICATE" | "CONFLICT">;
}

export class InMemoryJudgeWebhookEventStore implements JudgeWebhookEventStore {
  private readonly events = new Map<string, string>();

  async claim(eventId: string, bodyHash: string): Promise<"ACCEPTED" | "DUPLICATE" | "CONFLICT"> {
    const existing = this.events.get(eventId);
    if (existing === bodyHash) return "DUPLICATE";
    if (existing) return "CONFLICT";
    this.events.set(eventId, bodyHash);
    return "ACCEPTED";
  }

  get size(): number {
    return this.events.size;
  }
}

export interface ManagerResultSink {
  record(runId: string, task: ManagerEscalationTask): Promise<void>;
}

export class InMemoryManagerResultSink implements ManagerResultSink {
  readonly results: Array<{ runId: string; task: ManagerEscalationTask }> = [];

  async record(runId: string, task: ManagerEscalationTask): Promise<void> {
    this.results.push({ runId, task: structuredClone(task) });
  }
}

export type WebhookIngestionResult =
  | "REJECTED_AUTHENTICITY"
  | "REJECTED_PAYLOAD"
  | "DUPLICATE"
  | "EVENT_ID_CONFLICT"
  | "IGNORED_NON_TERMINAL"
  | "QUARANTINED_SCHEMA"
  | "ACCEPTED";

type NormalizedWebhook = {
  eventId: string;
  runId: string;
  callId: string;
  eventType: "call.completed" | "call.failed" | "call.result_validation_failed";
  snapshot: CallETaskSnapshot;
  status: ManagerEscalationTask["status"];
  outcome: ManagerEscalationTask["outcome"];
  taskCompleted: boolean;
  structuredResult: unknown;
  evidence: string[];
  transcript: string;
};

function normalizedStatus(value: string | undefined): ManagerEscalationTask["status"] {
  switch (value) {
    case "queued":
    case "in_progress":
    case "completed":
    case "failed":
      return value;
    default:
      return "failed";
  }
}

function normalizedOutcome(snapshot: CallETaskSnapshot): ManagerEscalationTask["outcome"] {
  const failure = callFailureText(snapshot);
  if (failure.includes("no_answer") || failure.includes("no answer")) return "NO_ANSWER";
  if (failure.includes("voicemail") || failure.includes("answering machine")) return "VOICEMAIL";
  if (failure.includes("timeout") || failure.includes("timed out")) return "TIMEOUT";
  return snapshot.status === "completed" ? "ANSWERED" : "FAILED";
}

function parseWebhook(rawBody: string): NormalizedWebhook | null {
  const envelope = parseCallEWebhookEnvelope(rawBody);
  if (!envelope) return null;
  const callId = callIdFrom(envelope.data);
  const runId = envelope.data.metadata?.workflow_run_id;
  if (!callId || typeof runId !== "string" || runId.length === 0) return null;

  return {
    eventId: envelope.id,
    runId,
    callId,
    eventType: envelope.type,
    snapshot: envelope.data,
    status: normalizedStatus(envelope.data.status),
    outcome: normalizedOutcome(envelope.data),
    taskCompleted: envelope.data.task_completed === true,
    structuredResult: recipientStructuredResult(envelope.data),
    evidence: Array.isArray(envelope.data.evidence)
      ? envelope.data.evidence.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    transcript: userTranscript(envelope.data),
  };
}

export class JudgeWebhookService {
  constructor(
    private readonly authenticity: WebhookAuthenticityVerifier,
    private readonly events: JudgeWebhookEventStore,
    private readonly results: ManagerResultSink,
  ) {}

  async ingest(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookIngestionResult> {
    if (!(await this.authenticity.verify(rawBody, headers))) {
      return "REJECTED_AUTHENTICITY";
    }
    const event = parseWebhook(rawBody);
    if (!event) return "REJECTED_PAYLOAD";

    const claim = await this.events.claim(event.eventId, await sha256(rawBody));
    if (claim === "DUPLICATE") return "DUPLICATE";
    if (claim === "CONFLICT") return "EVENT_ID_CONFLICT";
    if (
      event.eventType === "call.failed" ||
      !event.taskCompleted ||
      event.status !== "completed"
    ) {
      return "IGNORED_NON_TERMINAL";
    }

    const validation = validateManagerEscalationResult(event.structuredResult);
    if (!validation.valid || !validation.result) return "QUARANTINED_SCHEMA";

    const fieldEvidence: ManagerEscalationTask["fieldEvidence"] = {};
    for (const [field, excerpt] of Object.entries(validation.evidenceExcerpts)) {
      const verified = evidenceAppearsInTranscript(excerpt, event.transcript);
      fieldEvidence[field as "decision" | "preferredContactAt"] = {
        field: field as "decision" | "preferredContactAt",
        source: verified ? "transcript" : "recipient_result",
        excerpt,
        verified,
      };
    }
    const task: ManagerEscalationTask = {
      callId: event.callId,
      status: event.status,
      outcome: event.outcome,
      taskCompleted: event.taskCompleted,
      structuredResult: validation.result,
      evidence: event.evidence,
      fieldEvidence,
      schemaValidation: { valid: true, issues: [] },
    };
    await this.results.record(event.runId, task);
    return "ACCEPTED";
  }
}
