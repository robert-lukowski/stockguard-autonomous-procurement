import type { WorkflowResult } from "./types";

export type CallExecutionPolicy = {
  maximumAttempts: number;
  maximumPolls: number;
  timeoutMs: number;
  /**
   * Wait between two non-terminal status polls.
   *
   * A real telephone call takes tens of seconds to reach a terminal state.
   * Polling back to back exhausts `maximumPolls` in milliseconds and reports a
   * TIMEOUT before the callee has even answered, so a delay here is what makes
   * the poll budget mean anything at all.
   */
  pollIntervalMs: number;
  /** Wait before the first poll, while the call is still being placed. */
  initialPollDelayMs: number;
};

/**
 * Provisional qualification cadence.
 *
 * These numbers are OUR conservative starting point for the first controlled
 * qualification. They are NOT a cadence recommended by the CALL-E provider,
 * and nothing in this repository has yet observed real call timing. Re-derive
 * them from measured behaviour once a real call has been completed.
 *
 * `maximumAttempts` stays at 2. That is the budget that buys REAL PHONE CALLS
 * and it is the one that must never grow quietly.
 *
 * `maximumPolls` is a different kind of budget: status reads over HTTP, which
 * cost nothing and place no call. At 3 it capped the wait at ~25 seconds, far
 * less than a real conversation takes, so a call that succeeded would still be
 * recorded as TIMEOUT. It now spans five minutes:
 *
 *   initialPollDelayMs + (maximumPolls - 1) * pollIntervalMs
 *   = 15s + 57 * 5s = 300s
 *
 * Five minutes is a ceiling, not a wait: the loop exits the moment the task
 * reaches a terminal state, so a fast call still returns fast.
 */
export const defaultCallExecutionPolicy: CallExecutionPolicy = {
  maximumAttempts: 2,
  maximumPolls: 58,
  timeoutMs: 10_000,
  pollIntervalMs: 5_000,
  initialPollDelayMs: 15_000,
};

/** The wall-clock ceiling the poll budget above is chosen to cover. */
export const POLL_BUDGET_CEILING_MS = 300_000;

/** Injected so tests never wait on real time. */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface WorkflowRunStore {
  begin(runId: string): "STARTED" | "DUPLICATE";
  complete(runId: string, result: WorkflowResult): void;
  getResult(runId: string): WorkflowResult | null;
  cancel(runId: string): void;
  isCancelled(runId: string): boolean;
}

export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  private readonly started = new Set<string>();
  private readonly results = new Map<string, WorkflowResult>();
  private readonly cancelled = new Set<string>();

  begin(runId: string): "STARTED" | "DUPLICATE" {
    if (this.started.has(runId)) return "DUPLICATE";
    this.started.add(runId);
    return "STARTED";
  }

  complete(runId: string, result: WorkflowResult): void {
    if (!this.results.has(runId)) this.results.set(runId, result);
  }

  getResult(runId: string): WorkflowResult | null {
    return this.results.get(runId) ?? null;
  }

  cancel(runId: string): void {
    this.cancelled.add(runId);
  }

  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }
}

export type WebhookEnvelope = {
  eventId: string;
  runId: string;
  callId: string;
  receivedAt: string;
  payload: unknown;
};

export class WebhookDeduplicator {
  private readonly accepted = new Map<string, WebhookEnvelope>();

  ingest(event: WebhookEnvelope): "ACCEPTED" | "DUPLICATE" {
    if (this.accepted.has(event.eventId)) return "DUPLICATE";
    this.accepted.set(event.eventId, structuredClone(event));
    return "ACCEPTED";
  }

  get size(): number {
    return this.accepted.size;
  }
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("CALL_TIMEOUT")), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
