import { describe, expect, it } from "vitest";
import {
  MockCallEAdapter,
  type SupplierCallTask,
} from "../calle";
import {
  InMemoryWorkflowRunStore,
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
  defaultCallExecutionPolicy,
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
    const { workflow, base } = workflowWith(task("queued"), sleep);

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

  it("does not silently enlarge the retry budget", () => {
    // Guards against a future edit quietly buying more real phone calls.
    expect(defaultCallExecutionPolicy.maximumAttempts).toBe(2);
    expect(defaultCallExecutionPolicy.maximumPolls).toBe(3);
    expect(defaultCallExecutionPolicy.pollIntervalMs).toBeGreaterThan(0);
    expect(defaultCallExecutionPolicy.initialPollDelayMs).toBeGreaterThan(0);
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
