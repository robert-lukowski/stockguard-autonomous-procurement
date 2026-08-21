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

  it("models no compliant offer through bounded manager escalation", () => {
    const machine = new ProcurementStateMachine(
      "run-escalation",
      () => new Date("2026-08-21T10:00:00Z"),
    );
    machine.transition("DEMAND_DETECTED", "shortage confirmed");
    machine.transition("CONTACTS_PLANNED", "approved suppliers selected");
    machine.transition("CALLING", "supplier call started");
    machine.transition("OFFER_RECEIVED", "offer received");
    machine.transition("VALIDATING", "offers validated");
    machine.transition("POLICY_CHECK", "policy evaluated");
    machine.transition("NO_COMPLIANT_OFFER", "all offers rejected");
    machine.transition("HUMAN_ESCALATION_REQUIRED", "manager contact required");
    machine.transition("MANAGER_CALLING", "bounded call started");
    machine.transition("MANAGER_RESPONSE_RECEIVED", "response captured");
    machine.transition("AUTHENTICATED_APPROVAL_REQUIRED", "budget override refused");
    machine.transition("PROOF_SIGNED", "audit record signed");

    expect(machine.current).toBe("PROOF_SIGNED");
    expect(machine.history.every(({ runId }) => runId === "run-escalation")).toBe(true);
  });
});
