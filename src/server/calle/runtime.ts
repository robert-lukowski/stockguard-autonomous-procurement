export type CallETranscriptTurn = {
  offset_seconds?: number | null;
  speaker?: "bot" | "user" | "unknown";
  text?: string;
};

export type CallEAttemptSnapshot = {
  status?: string;
  summary?: string | null;
  transcript_turns?: CallETranscriptTurn[];
  failure_code?: string | null;
  failure_message?: string | null;
};

export type CallERecipientSnapshot = {
  status?: string;
  structured_result?: unknown;
  summary?: string | null;
  attempts?: CallEAttemptSnapshot[];
};

export type CallETaskSnapshot = {
  id?: string;
  call_id?: string;
  status?: string;
  recipients?: CallERecipientSnapshot[];
  structured_result?: unknown;
  task_completed?: boolean | null;
  completion_confidence?: { score?: number; label?: string } | number | null;
  evidence?: string[];
  metadata?: Record<string, unknown>;
  failure_code?: string | null;
  failure_message?: string | null;
};

export type CallEWebhookEnvelope = {
  id: string;
  type: "call.completed" | "call.failed" | "call.result_validation_failed";
  data: CallETaskSnapshot;
};

export function callIdFrom(snapshot: CallETaskSnapshot): string | null {
  const value = snapshot.id ?? snapshot.call_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function firstRecipient(
  snapshot: CallETaskSnapshot,
): CallERecipientSnapshot | null {
  return Array.isArray(snapshot.recipients) && snapshot.recipients.length > 0
    ? snapshot.recipients[0]
    : null;
}

export function recipientStructuredResult(
  snapshot: CallETaskSnapshot,
): unknown {
  return firstRecipient(snapshot)?.structured_result ?? snapshot.structured_result;
}

export function userTranscript(snapshot: CallETaskSnapshot): string {
  return (firstRecipient(snapshot)?.attempts ?? [])
    .flatMap((attempt) => attempt.transcript_turns ?? [])
    .filter((turn) => turn.speaker === "user" && typeof turn.text === "string")
    .map((turn) => turn.text!.trim())
    .filter((value) => value.length > 0)
    .join(" ");
}

function normalizedEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function evidenceAppearsInTranscript(
  excerpt: string,
  transcript: string,
): boolean {
  const normalizedExcerpt = normalizedEvidence(excerpt);
  const normalizedTranscript = normalizedEvidence(transcript);
  return (
    normalizedExcerpt.split(" ").filter(Boolean).length >= 2 &&
    normalizedTranscript.includes(normalizedExcerpt)
  );
}

export function callFailureText(snapshot: CallETaskSnapshot): string {
  const recipient = firstRecipient(snapshot);
  return [
    snapshot.failure_code,
    snapshot.failure_message,
    recipient?.summary,
    ...(recipient?.attempts ?? []).flatMap((attempt) => [
      attempt.failure_code,
      attempt.failure_message,
      attempt.summary,
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase("en-US");
}

export function parseCallEWebhookEnvelope(
  rawBody: string,
): CallEWebhookEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const allowedTypes = new Set([
    "call.completed",
    "call.failed",
    "call.result_validation_failed",
  ]);
  if (
    typeof record.id !== "string" ||
    typeof record.type !== "string" ||
    !allowedTypes.has(record.type) ||
    typeof record.data !== "object" ||
    record.data === null ||
    Array.isArray(record.data)
  ) {
    return null;
  }
  const data = record.data as CallETaskSnapshot;
  return callIdFrom(data)
    ? {
        id: record.id,
        type: record.type as CallEWebhookEnvelope["type"],
        data,
      }
    : null;
}
