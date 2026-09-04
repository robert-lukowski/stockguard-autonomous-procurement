import { describe, expect, it } from "vitest";

import {
  InMemoryMetricSink,
  InMemoryProcurementSessionStore,
  LocalTextChannel,
  ProcurementOrchestrator,
  interpretUtterance,
  searchCatalog,
  type SupplierQuotePort,
} from "./index";

const FIXED_NOW = new Date("2026-09-04T09:00:00.000Z");

function harness(overrides: { supplierQuotes?: SupplierQuotePort } = {}) {
  let counter = 0;
  const metrics = new InMemoryMetricSink();
  const orchestrator = new ProcurementOrchestrator({
    sessions: new InMemoryProcurementSessionStore(),
    metrics,
    clock: () => FIXED_NOW,
    newId: (prefix) => {
      counter += 1;
      return `${prefix}-${String(counter).padStart(4, "0")}`;
    },
    ...overrides,
  });
  return { orchestrator, metrics, channel: new LocalTextChannel(orchestrator) };
}

describe("natural-language product resolution", () => {
  it("reads quantity, product and delivery window out of a spoken sentence", () => {
    expect(interpretUtterance("I need twenty industrial SSD drives within a week.")).toEqual({
      rawText: "I need twenty industrial SSD drives within a week.",
      productQuery: "industrial ssd drives",
      quantity: 20,
      requiredWithinDays: 7,
    });
  });

  it("does not mistake a delivery deadline for a quantity", () => {
    const recognized = interpretUtterance("we need network adapters within seven days");
    expect(recognized.quantity).toBeNull();
    expect(recognized.requiredWithinDays).toBe(7);
    expect(recognized.productQuery).toBe("network adapters");
  });

  it("resolves compound number words and digit forms alike", () => {
    expect(interpretUtterance("order twenty five ecc memory modules").quantity).toBe(25);
    expect(interpretUtterance("order 25 ecc memory modules").quantity).toBe(25);
  });

  it("resolves a phrase to exactly one catalog SKU", () => {
    const result = searchCatalog("industrial ssd drives");
    expect(result.status).toBe("RESOLVED");
    expect(result.matches[0].sku).toBe("SSD-IND-960");
  });

  it("reports an unknown product as out of domain rather than guessing", () => {
    const result = searchCatalog("pepperoni pizza");
    expect(result.status).toBe("OUT_OF_DOMAIN");
    expect(result.matches).toEqual([]);
  });
});

describe("valid in-catalog request", () => {
  it("resolves, quotes, evaluates and asks for confirmation", async () => {
    const { channel } = harness();
    const { sessionId, mission } = await channel.start("MISSION-SSD-20");
    expect(mission.requestedQuantity).toBe(20);

    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");

    expect(turn.search?.status).toBe("RESOLVED");
    expect(turn.quote?.sku).toBe("SSD-IND-960");
    expect(turn.quote?.quantity).toBe(20);
    expect(turn.quote?.provenance).toBe("SUPPLIER_TOOL");
    expect(turn.evaluation?.outcome).toBe("ACCEPTED");
    expect(turn.evaluation?.orderTotal).toBe(1960);
    expect(turn.confirmationToken).not.toBeNull();
    expect(turn.message).toContain("Shall I create the purchase request?");
    expect(turn.toolInvocations.map((entry) => entry.tool)).toEqual([
      "searchInventory",
      "getSupplierQuote",
      "evaluatePurchase",
    ]);
    // The full evidence-aware gateway ran, not a reduced substitute.
    expect(turn.evaluation?.coreValidation.checks).toHaveLength(13);
    expect(turn.evaluation?.coreValidation.decision).toBe("PASS");
  });
});

describe("out-of-domain requests", () => {
  it("refuses pizza and names the categories it does support", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");

    const turn = await channel.say(sessionId, "can I order two large pepperoni pizzas");

    expect(turn.search?.status).toBe("OUT_OF_DOMAIN");
    expect(turn.quote).toBeNull();
    expect(turn.message).toContain("StockGuard industrial IT catalog");
    expect(turn.message).toContain("industrial storage");
    expect(turn.outcome).toBe("OUT_OF_DOMAIN");
    // A correct refusal is not a tool failure.
    expect(metrics.countOf("ToolError")).toBe(0);
    expect(metrics.countOf("RunRejected")).toBe(1);
  });
});

describe("invalid quantity", () => {
  it("refuses a quantity outside the catalog order range", async () => {
    const { orchestrator } = harness();
    const session = orchestrator.startSession("MISSION-SSD-20");

    const result = await orchestrator.tools.getSupplierQuote(
      session.sessionId,
      "SSD-IND-960",
      100_000,
      new Date(FIXED_NOW.getTime() + 7 * 86_400_000).toISOString(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe("QUANTITY_OUT_OF_RANGE");
  });

  it("refuses a SKU that is not in the catalog", async () => {
    const { orchestrator } = harness();
    const session = orchestrator.startSession("MISSION-SSD-20");

    const result = await orchestrator.tools.getSupplierQuote(
      session.sessionId,
      "PIZZA-XL-1",
      2,
      new Date(FIXED_NOW.getTime() + 7 * 86_400_000).toISOString(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe("SKU_NOT_IN_CATALOG");
  });
});

describe("quote exceeding budget", () => {
  it("rejects the purchase and names the budget check", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");

    const turn = await channel.say(sessionId, "I need forty industrial SSD drives within a week");

    expect(turn.quote?.quantity).toBe(40);
    expect(turn.evaluation?.outcome).toBe("REJECTED");
    expect(turn.evaluation?.blockingCheckIds).toContain("mission_budget");
    expect(turn.evaluation?.orderTotal).toBe(3920);
    expect(turn.confirmationToken).toBeNull();
    expect(metrics.countOf("RunRejected")).toBe(1);
  });
});

describe("delivery outside the required window", () => {
  it("rejects a quote that arrives after the deadline", async () => {
    const { channel } = harness();
    const { sessionId } = await channel.start("MISSION-UPS-4");

    const turn = await channel.say(sessionId, "I need four rack ups units within ten days");

    expect(turn.quote?.sku).toBe("UPS-RACK-3K");
    expect(turn.evaluation?.outcome).toBe("REJECTED");
    expect(turn.evaluation?.blockingCheckIds).toContain("mission_delivery_window");
  });
});

describe("explicit acceptance", () => {
  it("creates exactly one synthetic purchase request", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");
    const evaluationId = turn.evaluation!.evaluationId;

    const confirmed = await channel.decide(sessionId, evaluationId, turn.confirmationToken!, true);

    expect(confirmed.outcome).toBe("PURCHASE_REQUEST_CREATED");
    expect(confirmed.purchaseRequest?.status).toBe("CREATED");
    expect(confirmed.purchaseRequest?.synthetic).toBe(true);
    expect(confirmed.purchaseRequest?.totalPrice).toBe(1960);
    expect(confirmed.replayed).toBe(false);
    expect(metrics.countOf("RunAccepted")).toBe(1);
  });

  it("refuses to create a purchase request without the confirmation token", async () => {
    const { channel } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");

    const confirmed = await channel.decide(sessionId, turn.evaluation!.evaluationId, "", true);

    expect(confirmed.purchaseRequest).toBeNull();
    expect(confirmed.toolInvocations[0].error).toBe("CONFIRMATION_REQUIRED");
  });

  it("refuses a confirmation token that belongs to no evaluation", async () => {
    const { channel } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");

    const confirmed = await channel.decide(
      sessionId,
      turn.evaluation!.evaluationId,
      "confirm-forged",
      true,
    );

    expect(confirmed.purchaseRequest).toBeNull();
    expect(confirmed.toolInvocations[0].error).toBe("CONFIRMATION_INVALID");
  });
});

describe("rejection", () => {
  it("records a declined confirmation as its own outcome", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");

    const declined = await channel.decide(
      sessionId,
      turn.evaluation!.evaluationId,
      turn.confirmationToken!,
      false,
    );

    expect(declined.outcome).toBe("DECLINED_BY_USER");
    expect(declined.purchaseRequest).toBeNull();
    expect(metrics.countOf("RunAccepted")).toBe(0);
    expect(metrics.countOf("RunRejected")).toBe(1);
  });

  it("never creates a purchase request from a rejected evaluation", async () => {
    const { channel } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need forty industrial SSD drives within a week");

    const forced = await channel.decide(
      sessionId,
      turn.evaluation!.evaluationId,
      "confirm-anything",
      true,
    );

    expect(forced.purchaseRequest).toBeNull();
    expect(forced.toolInvocations[0].error).toBe("CONFIRMATION_INVALID");
  });
});

describe("human approval requirement", () => {
  it("escalates changed commercial terms without creating an order", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-NIC-12");

    const turn = await channel.say(sessionId, "we need twelve network adapters within ten days");
    expect(turn.evaluation?.outcome).toBe("HUMAN_REVIEW_REQUIRED");
    expect(turn.evaluation?.humanReviewCheckIds).toContain("commercial_terms_unchanged");
    expect(turn.confirmationToken).toBeNull();

    const escalated = await channel.escalate(sessionId, turn.evaluation!.evaluationId);

    expect(escalated.outcome).toBe("HUMAN_APPROVAL_REQUESTED");
    expect(escalated.humanApproval?.status).toBe("PENDING_HUMAN_APPROVAL");
    expect(escalated.humanApproval?.orderCreated).toBe(false);
    expect(escalated.humanApproval?.policyChanged).toBe(false);
    expect(metrics.countOf("RunHumanReview")).toBe(1);
    expect(metrics.countOf("RunAccepted")).toBe(0);
  });
});

describe("duplicate or replayed submission", () => {
  it("returns the original purchase request and counts the run once", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");
    const evaluationId = turn.evaluation!.evaluationId;
    const token = turn.confirmationToken!;

    const first = await channel.decide(sessionId, evaluationId, token, true);
    const replay = await channel.decide(sessionId, evaluationId, token, true);

    expect(replay.replayed).toBe(true);
    expect(replay.purchaseRequest?.purchaseRequestId).toBe(
      first.purchaseRequest?.purchaseRequestId,
    );
    expect(metrics.countOf("RunAccepted")).toBe(1);
  });
});

describe("tool failure", () => {
  it("reports a supplier outage without inventing a quote", async () => {
    const failingSupplier: SupplierQuotePort = {
      async quote() {
        throw new Error("supplier system unreachable");
      },
    };
    const { channel, metrics } = harness({ supplierQuotes: failingSupplier });
    const { sessionId } = await channel.start("MISSION-SSD-20");

    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");

    expect(turn.quote).toBeNull();
    expect(turn.evaluation).toBeNull();
    expect(turn.outcome).toBe("TOOL_FAILURE");
    expect(turn.message).toContain("No quote was produced");
    expect(metrics.countOf("ToolError")).toBe(1);
  });
});

describe("quote provenance", () => {
  it("refuses an evaluation for a quote the tool never issued", async () => {
    const { orchestrator } = harness();
    const session = orchestrator.startSession("MISSION-SSD-20");

    const result = await orchestrator.tools.evaluatePurchase(
      session.sessionId,
      "quote-invented-by-the-model",
      { ...(await import("./missions")).defaultMission },
      7,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe("QUOTE_NOT_FOUND");
  });

  it("detects a quote edited after issue", async () => {
    const sessions = new InMemoryProcurementSessionStore();
    let counter = 0;
    const orchestrator = new ProcurementOrchestrator({
      sessions,
      clock: () => FIXED_NOW,
      newId: (prefix) => {
        counter += 1;
        return `${prefix}-${String(counter).padStart(4, "0")}`;
      },
    });
    const channel = new LocalTextChannel(orchestrator);
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");

    const tampered = sessions.get(sessionId)!;
    tampered.quotes[turn.quote!.quoteId].unitPrice = 1;
    sessions.save(tampered);

    const result = await orchestrator.tools.createPurchaseRequest(
      sessionId,
      turn.evaluation!.evaluationId,
      turn.confirmationToken!,
      turn.mission,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toBe("QUOTE_PROVENANCE_INVALID");
  });
});

describe("audit trail and metrics", () => {
  it("produces a hash-chained audit trail for the accepted run", async () => {
    const { channel } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");
    await channel.decide(sessionId, turn.evaluation!.evaluationId, turn.confirmationToken!, true);

    const report = await channel.report(sessionId);
    const types = report.audit.chain.map((link) => link.payload.type);

    expect(types).toContain("SESSION_STARTED");
    expect(types).toContain("PRODUCT_RESOLVED");
    expect(types).toContain("QUOTE_ISSUED");
    expect(types).toContain("POLICY_EVALUATED");
    expect(types).toContain("CONFIRMATION_RECEIVED");
    expect(types).toContain("PURCHASE_REQUEST_CREATED");
    expect(types).toContain("RUN_COMPLETED");
    expect(report.audit.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.outcome).toBe("PURCHASE_REQUEST_CREATED");

    for (const [index, link] of report.audit.chain.entries()) {
      expect(link.sequence).toBe(index + 1);
      if (index > 0) {
        expect(link.previousHash).toBe(report.audit.chain[index - 1].hash);
      }
    }
  });

  it("emits every required operational metric", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    const turn = await channel.say(sessionId, "I need twenty industrial SSD drives within a week.");
    await channel.decide(sessionId, turn.evaluation!.evaluationId, turn.confirmationToken!, true);

    const names = new Set(metrics.all.map((metric) => metric.name));
    expect(names.has("RunStarted")).toBe(true);
    expect(names.has("RunAccepted")).toBe(true);
    expect(names.has("RunDurationMs")).toBe(true);
    for (const metric of metrics.all) {
      expect(metric.dimensions.Channel).toBe("local-text");
      expect(metric.dimensions.MissionId).toBe("MISSION-SSD-20");
    }
  });
});

describe("metric scoping", () => {
  it("reports only the metrics belonging to the requested session", async () => {
    const { orchestrator, channel } = harness();

    const first = await channel.start("MISSION-SSD-20");
    await channel.say(first.sessionId, "can I order a pizza");

    const second = await channel.start("MISSION-SSD-20");
    await channel.say(second.sessionId, "I need twenty industrial SSD drives within a week.");

    const firstReport = await orchestrator.report(first.sessionId);
    const secondReport = await orchestrator.report(second.sessionId);

    for (const metric of firstReport.metrics) {
      expect(metric.properties.sessionId).toBe(first.sessionId);
    }
    for (const metric of secondReport.metrics) {
      expect(metric.properties.sessionId).toBe(second.sessionId);
    }
    // The out-of-domain run must not appear in the accepted run's report.
    expect(secondReport.metrics.some((metric) => metric.name === "RunRejected")).toBe(false);
    expect(firstReport.metrics.some((metric) => metric.name === "RunRejected")).toBe(true);
  });

  it("keeps session identity out of CloudWatch dimensions", async () => {
    const { channel, metrics } = harness();
    const { sessionId } = await channel.start("MISSION-SSD-20");
    await channel.say(sessionId, "can I order a pizza");

    for (const metric of metrics.all) {
      expect(Object.keys(metric.dimensions)).toEqual(["Channel", "MissionId"]);
    }
  });
});
