import { describe, expect, it } from "vitest";

import { InMemoryDynamoDocument } from "../../aws/inMemoryDynamoDocument";
import { auditEvent } from "../audit";
import {
  InMemoryProcurementSessionStore,
  ProcurementSessionNotFound,
  type ProcurementSession,
  type ProcurementSessionStore,
} from "../sessionStore";
import type { PurchaseEvaluation, PurchaseRequest, SupplierQuote } from "../types";
import { DynamoProcurementSessionStore } from "./DynamoProcurementSessionStore";

/**
 * One contract, both stores.
 *
 * The in-memory store is kept for local development and tests, so the risk is
 * that it drifts from the durable one and tests pass against semantics
 * production does not have. Running the same suite against both removes that
 * risk: a guarantee only one of them provides fails here.
 */

const NOW = "2026-09-04T09:00:00.000Z";

function session(overrides: Partial<ProcurementSession> = {}): ProcurementSession {
  return {
    sessionId: "session-0001",
    missionId: "MISSION-SSD-20",
    channel: "judge-portal",
    startedAt: NOW,
    expiresAt: "2026-09-04T09:30:00.000Z",
    outcome: null,
    completedAt: null,
    quotes: {},
    evaluations: {},
    purchaseRequestsByToken: {},
    approvals: {},
    audit: [auditEvent("SESSION_STARTED", "session-0001", NOW, { missionId: "MISSION-SSD-20" })],
    ...overrides,
  };
}

const quote: SupplierQuote = {
  quoteId: "quote-0001",
  sessionId: "session-0001",
  sku: "SSD-IND-960",
  quantity: 20,
  supplierId: "supplier-en-01",
  supplierName: "Ridgeline Industrial Supply",
  unitPrice: 98,
  currency: "USD",
  availableQuantity: 20,
  deliveryAt: "2026-09-10T09:00:00.000Z",
  offerValidUntil: "2026-09-05T09:00:00.000Z",
  commercialTermsChanged: false,
  commercialTermsSummary: "Standard approved commercial terms remain unchanged.",
  issuedAt: NOW,
  expiresAt: "2026-09-04T09:10:00.000Z",
  datasetVersion: "judge-portal-suppliers-2026-09-v1",
  provenance: "SUPPLIER_TOOL",
  provenanceHash: "a".repeat(64),
};

const evaluation = {
  evaluationId: "eval-0001",
  sessionId: "session-0001",
  quoteId: quote.quoteId,
  quoteProvenanceHash: quote.provenanceHash,
  outcome: "ACCEPTED",
  coreValidation: {
    decision: "PASS",
    checks: [],
    policyVersion: "stockguard-judge-portal-policy-v1",
    failedCheckIds: [],
    humanReviewCheckIds: [],
  },
  missionChecks: [],
  checks: [],
  orderTotal: 1960,
  orderCurrency: "USD",
  explanation: "ok",
  blockingCheckIds: [],
  humanReviewCheckIds: [],
  confirmationRequired: true,
  confirmationToken: "confirm-0001",
  evaluatedAt: NOW,
} as unknown as PurchaseEvaluation;

function purchaseRequest(id: string): PurchaseRequest {
  return {
    purchaseRequestId: id,
    sessionId: "session-0001",
    quoteId: quote.quoteId,
    evaluationId: evaluation.evaluationId,
    sku: quote.sku,
    quantity: quote.quantity,
    unitPrice: quote.unitPrice,
    currency: quote.currency,
    totalPrice: 1960,
    supplierId: quote.supplierId,
    supplierName: quote.supplierName,
    deliveryAt: quote.deliveryAt,
    createdAt: NOW,
    status: "CREATED",
    synthetic: true,
  };
}

const implementations: Array<[string, () => ProcurementSessionStore]> = [
  ["InMemoryProcurementSessionStore", () => new InMemoryProcurementSessionStore()],
  [
    "DynamoProcurementSessionStore",
    () => new DynamoProcurementSessionStore(new InMemoryDynamoDocument(), "stockguard-procurement"),
  ],
];

describe.each(implementations)("%s", (_name, build) => {
  it("creates a session once and rejects a duplicate id", async () => {
    const store = build();

    expect(await store.create(session())).toBe("CREATED");
    expect(await store.create(session())).toBe("DUPLICATE");
  });

  it("round-trips the whole session", async () => {
    const store = build();
    await store.create(session());

    await store.putQuote("session-0001", quote);
    await store.putEvaluation("session-0001", evaluation);
    await store.putApproval("session-0001", {
      approvalRequestId: "approval-0001",
      sessionId: "session-0001",
      quoteId: quote.quoteId,
      evaluationId: evaluation.evaluationId,
      reasonCheckIds: ["commercial_terms_unchanged"],
      createdAt: NOW,
      status: "PENDING_HUMAN_APPROVAL",
      orderCreated: false,
      policyChanged: false,
    });

    const loaded = await store.get("session-0001");

    expect(loaded?.missionId).toBe("MISSION-SSD-20");
    expect(loaded?.quotes["quote-0001"]).toEqual(quote);
    expect(loaded?.evaluations["eval-0001"].outcome).toBe("ACCEPTED");
    expect(loaded?.approvals["approval-0001"].orderCreated).toBe(false);
    expect(loaded?.audit.map((event) => event.type)).toEqual(["SESSION_STARTED"]);
  });

  it("returns null for a session that was never created", async () => {
    expect(await build().get("session-missing")).toBeNull();
  });

  it("consumes a confirmation token exactly once", async () => {
    const store = build();
    await store.create(session());

    const first = await store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-0001"));
    const second = await store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-0002"));

    expect(first.kind).toBe("CLAIMED");
    expect(first.request.purchaseRequestId).toBe("pr-0001");
    expect(second.kind).toBe("DUPLICATE");
    // The second request is discarded; the first one is what exists.
    expect(second.request.purchaseRequestId).toBe("pr-0001");
  });

  it("keeps concurrent confirmations of one token to a single purchase request", async () => {
    const store = build();
    await store.create(session());

    const results = await Promise.all([
      store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-a")),
      store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-b")),
      store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-c")),
    ]);

    expect(results.filter((result) => result.kind === "CLAIMED")).toHaveLength(1);
    const ids = new Set(results.map((result) => result.request.purchaseRequestId));
    expect(ids.size).toBe(1);

    const loaded = await store.get("session-0001");
    expect(Object.keys(loaded?.purchaseRequestsByToken ?? {})).toHaveLength(1);
  });

  it("treats different tokens as different claims", async () => {
    const store = build();
    await store.create(session());

    const first = await store.claimConfirmation("session-0001", "confirm-a", purchaseRequest("pr-a"));
    const second = await store.claimConfirmation("session-0001", "confirm-b", purchaseRequest("pr-b"));

    expect(first.kind).toBe("CLAIMED");
    expect(second.kind).toBe("CLAIMED");
  });

  it("completes a run exactly once", async () => {
    const store = build();
    await store.create(session());

    expect(await store.complete("session-0001", "PURCHASE_REQUEST_CREATED", NOW)).toBe("COMPLETED");
    expect(await store.complete("session-0001", "REJECTED_BY_POLICY", NOW)).toBe("ALREADY_COMPLETED");

    const loaded = await store.get("session-0001");
    expect(loaded?.outcome).toBe("PURCHASE_REQUEST_CREATED");
    expect(loaded?.completedAt).toBe(NOW);
  });

  it("keeps concurrent completions to a single winner", async () => {
    const store = build();
    await store.create(session());

    const results = await Promise.all([
      store.complete("session-0001", "PURCHASE_REQUEST_CREATED", NOW),
      store.complete("session-0001", "REJECTED_BY_POLICY", NOW),
      store.complete("session-0001", "DECLINED_BY_USER", NOW),
    ]);

    expect(results.filter((result) => result === "COMPLETED")).toHaveLength(1);
  });

  it("appends audit events in the order they happened", async () => {
    const store = build();
    await store.create(session());

    await store.appendAudit("session-0001", [
      auditEvent("PRODUCT_RESOLVED", "session-0001", "2026-09-04T09:00:01.000Z", {}),
      auditEvent("QUOTE_ISSUED", "session-0001", "2026-09-04T09:00:02.000Z", {}),
    ]);
    await store.appendAudit("session-0001", [
      auditEvent("POLICY_EVALUATED", "session-0001", "2026-09-04T09:00:03.000Z", {}),
    ]);

    const loaded = await store.get("session-0001");

    expect(loaded?.audit.map((event) => event.type)).toEqual([
      "SESSION_STARTED",
      "PRODUCT_RESOLVED",
      "QUOTE_ISSUED",
      "POLICY_EVALUATED",
    ]);
  });

  it("keeps two audit events written in the same millisecond distinct and ordered", async () => {
    const store = build();
    await store.create(session());

    await store.appendAudit("session-0001", [
      auditEvent("PRODUCT_RESOLVED", "session-0001", "2026-09-04T09:00:01.000Z", { step: 1 }),
      auditEvent("QUOTE_ISSUED", "session-0001", "2026-09-04T09:00:01.000Z", { step: 2 }),
    ]);

    const loaded = await store.get("session-0001");

    expect(loaded?.audit).toHaveLength(3);
    expect(loaded?.audit.slice(1).map((event) => event.detail.step)).toEqual([1, 2]);
  });

  it("refuses to write against a session that does not exist", async () => {
    const store = build();

    await expect(store.putQuote("session-missing", quote)).rejects.toBeInstanceOf(
      ProcurementSessionNotFound,
    );
    await expect(
      store.appendAudit("session-missing", [auditEvent("QUOTE_ISSUED", "session-missing", NOW)]),
    ).rejects.toBeInstanceOf(ProcurementSessionNotFound);
  });
});

describe("DynamoProcurementSessionStore item layout", () => {
  it("gives every child item the session TTL so nothing outlives its session", async () => {
    const client = new InMemoryDynamoDocument();
    const store = new DynamoProcurementSessionStore(client, "stockguard-procurement");
    await store.create(session());
    await store.putQuote("session-0001", quote);
    await store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-0001"));

    const writes = client.commands.filter(
      (command): command is Extract<typeof command, { operation: "Put" }> =>
        command.operation === "Put",
    );

    expect(writes.length).toBeGreaterThan(2);
    for (const write of writes) {
      expect(write.item.expiresAtEpoch).toBe(Math.floor(Date.parse("2026-09-04T09:30:00.000Z") / 1000));
      expect(String(write.item.PK)).toBe("PSESSION#session-0001");
    }
  });

  it("guards the single-use token and the run completion with conditions", async () => {
    const client = new InMemoryDynamoDocument();
    const store = new DynamoProcurementSessionStore(client, "stockguard-procurement");
    await store.create(session());
    await store.claimConfirmation("session-0001", "confirm-0001", purchaseRequest("pr-0001"));
    await store.complete("session-0001", "PURCHASE_REQUEST_CREATED", NOW);

    const confirmWrite = client.commands.find(
      (command) =>
        command.operation === "Put" && String(command.item.SK).startsWith("CONFIRM#"),
    );
    const completion = client.commands.find((command) => command.operation === "Update");

    expect(confirmWrite).toMatchObject({ conditionExpression: "attribute_not_exists(#pk)" });
    expect(completion).toMatchObject({
      conditionExpression: "attribute_exists(#pk) AND #outcome = :unset",
    });
  });
});

describe("audit events survive concurrent batches", () => {
  it.each(implementations)("%s keeps every event when batches share a millisecond", async (_name, build) => {
    const store = build();
    await store.create(session());

    /*
     * The batch-local index restarts at zero on every call, so two batches at
     * the same instant would collide on an unconditional write and the later
     * one would silently overwrite the earlier evidence.
     */
    const at = "2026-09-04T09:00:01.000Z";
    await Promise.all([
      store.appendAudit("session-0001", [
        auditEvent("PRODUCT_RESOLVED", "session-0001", at, { batch: "a", step: 1 }),
        auditEvent("QUOTE_ISSUED", "session-0001", at, { batch: "a", step: 2 }),
      ]),
      store.appendAudit("session-0001", [
        auditEvent("PRODUCT_RESOLVED", "session-0001", at, { batch: "b", step: 1 }),
        auditEvent("QUOTE_ISSUED", "session-0001", at, { batch: "b", step: 2 }),
      ]),
    ]);

    const loaded = await store.get("session-0001");

    // One SESSION_STARTED plus all four appended events. Nothing lost.
    expect(loaded?.audit).toHaveLength(5);
    expect(loaded?.audit.filter((event) => event.detail.batch === "a")).toHaveLength(2);
    expect(loaded?.audit.filter((event) => event.detail.batch === "b")).toHaveLength(2);
  });
});
