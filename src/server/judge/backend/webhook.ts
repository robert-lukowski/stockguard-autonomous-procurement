import { sha256 } from "../../../security";
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
  status: ManagerEscalationTask["status"];
  outcome: ManagerEscalationTask["outcome"];
  taskCompleted: boolean;
  structuredResult: unknown;
  evidence: string[];
  fieldEvidence: ManagerEscalationTask["fieldEvidence"];
};

const statuses = new Set<ManagerEscalationTask["status"]>([
  "planned",
  "queued",
  "in_progress",
  "completed",
  "failed",
]);
const outcomes = new Set<ManagerEscalationTask["outcome"]>([
  "ANSWERED",
  "NO_ANSWER",
  "VOICEMAIL",
  "TIMEOUT",
  "FAILED",
]);

function parseWebhook(rawBody: string): NormalizedWebhook | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.eventId !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.callId !== "string" ||
    typeof record.status !== "string" ||
    !statuses.has(record.status as ManagerEscalationTask["status"]) ||
    typeof record.outcome !== "string" ||
    !outcomes.has(record.outcome as ManagerEscalationTask["outcome"]) ||
    typeof record.taskCompleted !== "boolean"
  ) {
    return null;
  }
  return {
    eventId: record.eventId,
    runId: record.runId,
    callId: record.callId,
    status: record.status as ManagerEscalationTask["status"],
    outcome: record.outcome as ManagerEscalationTask["outcome"],
    taskCompleted: record.taskCompleted,
    structuredResult: record.structuredResult,
    evidence: Array.isArray(record.evidence)
      ? record.evidence.filter((item): item is string => typeof item === "string")
      : [],
    fieldEvidence:
      typeof record.fieldEvidence === "object" && record.fieldEvidence !== null
        ? (record.fieldEvidence as ManagerEscalationTask["fieldEvidence"])
        : {},
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
    if (!event.taskCompleted || !["completed", "failed"].includes(event.status)) {
      return "IGNORED_NON_TERMINAL";
    }

    const validation = validateManagerEscalationResult(event.structuredResult);
    if (!validation.valid || !validation.result) return "QUARANTINED_SCHEMA";
    const task: ManagerEscalationTask = {
      callId: event.callId,
      status: event.status,
      outcome: event.outcome,
      taskCompleted: event.taskCompleted,
      structuredResult: validation.result,
      evidence: event.evidence,
      fieldEvidence: event.fieldEvidence,
      schemaValidation: { valid: true, issues: [] },
    };
    await this.results.record(event.runId, task);
    return "ACCEPTED";
  }
}
