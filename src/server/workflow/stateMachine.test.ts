import { describe, expect, it } from "vitest";
import { ProcurementStateMachine } from "./stateMachine";

describe("ProcurementStateMachine", () => {
  it("records controlled transitions with one runId", () => {
    const machine = new ProcurementStateMachine(
      "run-1",
      () => new Date("2026-08-21T10:00:00Z"),
    );
    machine.transition("DEMAND_DETECTED", "shortage confirmed");
    machine.transition("CONTACTS_PLANNED", "approved suppliers selected");
    machine.transition("CALLING", "mock call started");
    machine.transition("OFFER_RECEIVED", "structured result received");

    expect(machine.current).toBe("OFFER_RECEIVED");
    expect(machine.history).toHaveLength(4);
    expect(machine.history.every(({ runId }) => runId === "run-1")).toBe(true);
  });

  it("rejects an uncontrolled transition", () => {
    const machine = new ProcurementStateMachine("run-1", () => new Date());
    expect(() => machine.transition("ORDER_PREPARED", "skip controls")).toThrow(
      "Invalid workflow transition IDLE -> ORDER_PREPARED",
    );
  });
});
