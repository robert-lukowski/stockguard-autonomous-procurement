import { describe, expect, it } from "vitest";
import {
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
  return JSON.stringify({
    eventId,
    runId: "run-no-offer",
    callId: "call-1",
    status: "completed",
    outcome: "ANSWERED",
    taskCompleted: true,
    structuredResult: {
      decision,
      preferredContactAt: null,
      restrictedActionsRequested: [],
      optOutRequested: false,
      summary: "Send the report",
    },
    evidence: ["Synthetic transcript"],
    fieldEvidence: {
      decision: {
        field: "decision",
        source: "transcript",
        excerpt: "Please send the written report",
        verified: true,
      },
    },
  });
}

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

    expect(await service.ingest(body, { "x-test-signature": "verified" })).toBe("ACCEPTED");
    expect(await service.ingest(body, { "x-test-signature": "verified" })).toBe("DUPLICATE");
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
