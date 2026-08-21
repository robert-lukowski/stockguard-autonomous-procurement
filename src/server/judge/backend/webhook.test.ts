import { describe, expect, it, vi } from "vitest";
import {
  CallEWebhookAuthenticityVerifier,
  FailClosedWebhookAuthenticityVerifier,
  InMemoryJudgeWebhookEventStore,
  InMemoryManagerResultSink,
  JudgeWebhookService,
  type WebhookAuthenticityVerifier,
} from ".";

const allow: WebhookAuthenticityVerifier = {
  async verify() {
    return true;
  },
};

function payload(eventId = "event-1", decision = "REQUEST_WRITTEN_REPORT") {
  const decisionEvidence = `Manager selected ${decision}`;
  return JSON.stringify({
    id: eventId,
    type: "call.completed",
    created_at: "2026-08-21T10:05:00Z",
    data: {
      id: "call-1",
      status: "completed",
      recipients: [{
        status: "completed",
        structured_result: {
          decision,
          restrictedActionsRequested: [],
          optOutRequested: false,
          managerSummary: "Bounded manager response captured",
          decisionEvidence,
        },
        attempts: [{
          status: "completed",
          transcript_turns: [{
            speaker: "user",
            text: decisionEvidence,
          }],
        }],
      }],
      task_completed: true,
      completion_confidence: { score: 0.98, label: "high" },
      evidence: ["Synthetic transcript"],
      metadata: { workflow_run_id: "run-no-offer" },
      failure_code: null,
      failure_message: null,
    },
  });
}

describe("CallEWebhookAuthenticityVerifier", () => {
  it("accepts a matching event header and authoritative CALL-E snapshot", async () => {
    const body = payload("event-authentic");
    const snapshot = JSON.parse(body).data;
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );
    const verifier = new CallEWebhookAuthenticityVerifier({
      apiKey: "test-only",
      fetchImplementation,
    });

    await expect(
      verifier.verify(body, { "call-e-event-id": "event-authentic" }),
    ).resolves.toBe(true);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.heycall-e.com/v1/calls/call-1",
      { headers: { Authorization: "Bearer test-only" } },
    );
  });

  it("rejects a missing or mismatched CALL-E event header", async () => {
    const fetchImplementation = vi.fn();
    const verifier = new CallEWebhookAuthenticityVerifier({
      apiKey: "test-only",
      fetchImplementation,
    });
    const body = payload("event-header-check");

    await expect(verifier.verify(body, {})).resolves.toBe(false);
    await expect(
      verifier.verify(body, { "call-e-event-id": "different-event" }),
    ).resolves.toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects a webhook whose authoritative CALL-E snapshot differs", async () => {
    const body = payload("event-modified");
    const snapshot = JSON.parse(body).data;
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ...snapshot, status: "failed" }),
        { status: 200 },
      ),
    );
    const verifier = new CallEWebhookAuthenticityVerifier({
      apiKey: "test-only",
      fetchImplementation,
    });

    await expect(
      verifier.verify(body, { "call-e-event-id": "event-modified" }),
    ).resolves.toBe(false);
  });
});

describe("JudgeWebhookService", () => {
  it("rejects every webhook when no provider authenticity mechanism is configured", async () => {
    const sink = new InMemoryManagerResultSink();
    const service = new JudgeWebhookService(
      new FailClosedWebhookAuthenticityVerifier(),
      new InMemoryJudgeWebhookEventStore(),
      sink,
    );

    expect(await service.ingest(payload(), {})).toBe("REJECTED_AUTHENTICITY");
    expect(sink.results).toHaveLength(0);
  });

  it("accepts one verified terminal result and deduplicates the repeated event", async () => {
    const events = new InMemoryJudgeWebhookEventStore();
    const sink = new InMemoryManagerResultSink();
    const service = new JudgeWebhookService(allow, events, sink);
    const body = payload();

    expect(await service.ingest(body, { "call-e-event-id": "event-1" })).toBe("ACCEPTED");
    expect(await service.ingest(body, { "call-e-event-id": "event-1" })).toBe("DUPLICATE");
    expect(events.size).toBe(1);
    expect(sink.results).toHaveLength(1);
    expect(sink.results[0].runId).toBe("run-no-offer");
  });

  it("detects reuse of an event ID with modified content", async () => {
    const sink = new InMemoryManagerResultSink();
    const service = new JudgeWebhookService(
      allow,
      new InMemoryJudgeWebhookEventStore(),
      sink,
    );

    expect(await service.ingest(payload("event-conflict"), {})).toBe("ACCEPTED");
    expect(
      await service.ingest(
        payload("event-conflict", "DECLINE_ESCALATION"),
        {},
      ),
    ).toBe("EVENT_ID_CONFLICT");
    expect(sink.results).toHaveLength(1);
  });

  it("quarantines a schema-invalid decision", async () => {
    const sink = new InMemoryManagerResultSink();
    const service = new JudgeWebhookService(
      allow,
      new InMemoryJudgeWebhookEventStore(),
      sink,
    );

    expect(await service.ingest(payload("event-invalid", "BUY_ANYWAY"), {})).toBe("QUARANTINED_SCHEMA");
    expect(sink.results).toHaveLength(0);
  });
});
