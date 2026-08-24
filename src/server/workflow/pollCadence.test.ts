import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALLE_HTTP_TIMEOUT_MS,
  MockCallEAdapter,
  type SupplierCallTask,
} from "../calle";
import {
  InMemoryWorkflowRunStore,
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
  defaultCallExecutionPolicy,
  POLL_BUDGET_CEILING_MS,
  type SupplierContact,
  type WorkflowInput,
} from ".";

/**
 * Cadence tests use a recording sleep, so they assert the delays that WOULD
 * be taken without ever waiting on real time.
 */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const supplier: SupplierContact = {
  supplierId: "supplier-de-01",
  supplierName: "NordWerk Supply",
  phoneE164: "+15550100001",
  region: "DE",
  locale: "de-DE",
  approved: true,
  consentVerified: true,
};

function task(status: SupplierCallTask["status"]): SupplierCallTask {
  return {
    callId: "call-1",
    status,
    taskCompleted: status === "completed",
    completionConfidence: status === "completed" ? 0.95 : 0,
    structuredResult: null,
    evidence: [],
    fieldEvidence: {},
    schemaValidation: { valid: false, issues: [{ field: "$", message: "n/a" }] },
    outcome: status === "completed" ? "ANSWERED" : "INCOMPLETE",
  };
}

function input(): WorkflowInput {
  return {
    workflowId: `wf-cadence-${Math.random()}`,
    inventory: {
      sku: "CF-220",
      onHand: 8,
      confirmedDemand: 14,
      inboundConfirmed: 0,
      safetyStock: 2,
      stockoutAt: "2026-08-28T12:00:00+02:00",
    },
    suppliers: [supplier],
    callAuthorization: {
      workflowId: "",
      approvedBy: "test",
      approvedAt: "2026-08-21T09:00:00Z",
      expiresAt: "2099-08-21T10:00:00Z",
      maximumCalls: 3,
      allowedSupplierIds: [supplier.supplierId],
      allowedPhoneNumbers: [supplier.phoneE164],
    },
    procurementPolicy: {
      version: "TEST-v1",
      autonomousOrderLimitEur: 500,
      unitPriceCeilingEur: 45,
      minimumConfidence: 0.9,
      maximumAttempts: 2,
      approvedCurrencies: ["EUR"],
    },
    exchangeRates: { EUR: 1, PLN: 0.2329, USD: 0.86, GBP: 1.16 },
    autonomousExecutionEnabled: true,
  };
}

function workflowWith(
  first: SupplierCallTask,
  sleep: (ms: number) => Promise<void>,
  policy = { ...defaultCallExecutionPolicy, maximumAttempts: 1 },
) {
  const base = input();
  base.callAuthorization.workflowId = base.workflowId;
  return {
    base,
    workflow: new ProcurementWorkflow(
      new MockCallEAdapter({ [supplier.supplierId]: first }),
      new MockPurchaseOrderAdapter(),
      () => new Date("2026-08-21T10:30:00Z"),
      undefined,
      new InMemoryWorkflowRunStore(),
      policy,
      sleep,
    ),
  };
}

describe("supplier call poll cadence", () => {
  it("waits between non-terminal polls instead of exhausting the budget instantly", async () => {
    const { waits, sleep } = recordingSleep();
    // Spacing is what this test is about, so it pins maximumPolls itself rather
    // than inheriting the default budget.
    const { workflow, base } = workflowWith(task("queued"), sleep, {
      ...defaultCallExecutionPolicy,
      maximumAttempts: 1,
      maximumPolls: 3,
    });

    await workflow.run(base);

    // One initial delay, then one interval before each subsequent poll.
    expect(waits).toEqual([
      defaultCallExecutionPolicy.initialPollDelayMs,
      defaultCallExecutionPolicy.pollIntervalMs,
      defaultCallExecutionPolicy.pollIntervalMs,
    ]);
  });

  it("never waits when the first response is already terminal", async () => {
    const { waits, sleep } = recordingSleep();
    const { workflow, base } = workflowWith(task("completed"), sleep);

    await workflow.run(base);

    expect(waits).toEqual([]);
  });

  it("keeps the poll budget bounded by maximumPolls", async () => {
    const { waits, sleep } = recordingSleep();
    const { workflow, base } = workflowWith(task("in_progress"), sleep, {
      ...defaultCallExecutionPolicy,
      maximumAttempts: 1,
      maximumPolls: 2,
    });

    const result = await workflow.run(base);

    expect(waits).toHaveLength(2);
    expect(result.auditTimeline.some((event) => event.type === "CALL_TIMEOUT")).toBe(
      true,
    );
  });

  it("does not silently enlarge the budget that buys real phone calls", () => {
    // maximumAttempts is the one that costs money and rings a real handset.
    // maximumPolls only reads status over HTTP, so it is allowed to be large -
    // but the spacing must stay non-zero or the budget means nothing.
    expect(defaultCallExecutionPolicy.maximumAttempts).toBe(2);
    expect(defaultCallExecutionPolicy.pollIntervalMs).toBeGreaterThan(0);
    expect(defaultCallExecutionPolicy.initialPollDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_CALLE_HTTP_TIMEOUT_MS).toBe(30_000);
    expect(defaultCallExecutionPolicy.timeoutMs).toBeGreaterThan(
      DEFAULT_CALLE_HTTP_TIMEOUT_MS,
    );
    expect(defaultCallExecutionPolicy.timeoutMs).not.toBe(10_000);
  });

  it("waits long enough for a real conversation to finish", () => {
    // At 3 polls the ceiling was ~25s, so a call that actually succeeded was
    // still recorded as TIMEOUT. The budget must cover a real call.
    const ceiling =
      defaultCallExecutionPolicy.initialPollDelayMs +
      (defaultCallExecutionPolicy.maximumPolls - 1) *
        defaultCallExecutionPolicy.pollIntervalMs;

    expect(ceiling).toBe(POLL_BUDGET_CEILING_MS);
    expect(ceiling).toBe(300_000);
  });

  it("stops polling when the run is cancelled mid-wait", async () => {
    const store = new InMemoryWorkflowRunStore();
    const base = input();
    base.callAuthorization.workflowId = base.workflowId;
    let waits = 0;
    const workflow = new ProcurementWorkflow(
      new MockCallEAdapter({ [supplier.supplierId]: task("queued") }),
      new MockPurchaseOrderAdapter(),
      () => new Date("2026-08-21T10:30:00Z"),
      undefined,
      store,
      { ...defaultCallExecutionPolicy, maximumAttempts: 1 },
      async () => {
        waits += 1;
        store.cancel(base.workflowId);
      },
    );

    const result = await workflow.run(base);

    expect(waits).toBe(1);
    expect(result.status).toBe("HUMAN_ESCALATION_REQUIRED");
  });
});
