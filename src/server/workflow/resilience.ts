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
 * `maximumAttempts` and `maximumPolls` are deliberately unchanged: this fixes
 * the spacing of the existing budget, it does not enlarge it.
 */
export const defaultCallExecutionPolicy: CallExecutionPolicy = {
  maximumAttempts: 2,
  maximumPolls: 3,
  timeoutMs: 10_000,
  pollIntervalMs: 5_000,
  initialPollDelayMs: 15_000,
};

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
