import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRunStore, WebhookDeduplicator, withTimeout } from "./resilience";

describe("execution resilience", () => {
  it("deduplicates webhook deliveries by event ID", () => {
    const deduplicator = new WebhookDeduplicator();
    const event = {
      eventId: "evt-1",
      runId: "run-1",
      callId: "call-1",
      receivedAt: "2026-08-21T10:00:00Z",
      payload: { status: "completed" },
    };

    expect(deduplicator.ingest(event)).toBe("ACCEPTED");
    expect(deduplicator.ingest(event)).toBe("DUPLICATE");
    expect(deduplicator.size).toBe(1);
  });

  it("claims a workflow run only once", () => {
    const store = new InMemoryWorkflowRunStore();
    expect(store.begin("run-1")).toBe("STARTED");
    expect(store.begin("run-1")).toBe("DUPLICATE");
  });

  it("fails a non-resolving operation with a controlled timeout", async () => {
    await expect(withTimeout(new Promise(() => undefined), 5)).rejects.toThrow(
      "CALL_TIMEOUT",
    );
  });
});
