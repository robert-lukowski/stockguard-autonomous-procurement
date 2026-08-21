import { describe, expect, it, vi } from "vitest";
import { runDemoWorkflow, runManagerEscalationDemo } from "../../demo/runDemoWorkflow";
import { verifyDecisionProof } from "../../security";
import {
  CallEManagerEscalationAdapter,
  ManagerEscalationWorkflow,
  ManagerEscalationSafetyError,
  MockManagerEscalationAdapter,
  validateManagerEscalationResult,
  type ManagerEscalationAuthorization,
  type ManagerEscalationRequest,
} from ".";

const request: ManagerEscalationRequest = {
  runId: "run-1",
  sessionId: "session-1",
  attemptNumber: 1,
  idempotencyKey: "session-1:run-1:manager-escalation:attempt:1",
  phoneE164: "+15550109999",
  locale: "en-GB",
  consentConfirmed: true,
  context: {
    organizationName: "Northstar Manufacturing",
    sku: "CF-220",
    requiredQuantity: 8,
    stockoutAt: "2026-08-28T12:00:00+02:00",
    rejectedOffers: [
      {
        supplierName: "NordWerk Supply",
        failedChecks: ["quantity"],
        requiresHumanChecks: [],
      },
    ],
  },
};

const authorization: ManagerEscalationAuthorization = {
  sessionId: request.sessionId,
  accessCodeVerifiedServerSide: true,
  issuedAt: "2026-08-21T10:00:00Z",
  expiresAt: "2099-08-21T10:15:00Z",
  allowedPhoneE164: request.phoneE164,
  maximumCalls: 1,
  consentRecordedAt: "2026-08-21T10:00:30Z",
  killSwitchActive: false,
};

describe("manager escalation result validation", () => {
  it("accepts only the bounded decision schema", () => {
    const result = validateManagerEscalationResult({
      decision: "REQUEST_WRITTEN_REPORT",
      preferredContactAt: null,
      restrictedActionsRequested: [],
      optOutRequested: false,
      summary: "Send the report",
    });

    expect(result.valid).toBe(true);
    expect(result.result?.decision).toBe("REQUEST_WRITTEN_REPORT");
  });

  it("rejects arbitrary free-form decisions", () => {
    const result = validateManagerEscalationResult({
      decision: "BUY_FROM_ANYONE_NOW",
      preferredContactAt: null,
      restrictedActionsRequested: [],
      optOutRequested: false,
      summary: null,
    });

    expect(result.valid).toBe(false);
    expect(result.result).toBeNull();
  });
});

describe("MockManagerEscalationAdapter", () => {
  it("returns the same task for the same idempotency key without consuming another call", async () => {
    const adapter = new MockManagerEscalationAdapter("REQUEST_WRITTEN_REPORT");

    const first = await adapter.startManagerEscalation(request, authorization);
    const duplicate = await adapter.startManagerEscalation(request, authorization);

    expect(duplicate).toEqual(first);
    expect(first.fieldEvidence.decision?.verified).toBe(true);
  });

  it("keeps the live CALL-E adapter fail-closed when real calls are disabled", async () => {
    const adapter = new CallEManagerEscalationAdapter({
      apiKey: "test-only",
      realCallsEnabled: false,
      fetchImplementation: vi.fn(),
    });

    await expect(
      adapter.startManagerEscalation(request, authorization),
    ).rejects.toEqual(
      new ManagerEscalationSafetyError(
        "Real manager calls are disabled",
        "REAL_CALLS_DISABLED",
      ),
    );
  });
});

describe("ManagerEscalationWorkflow", () => {
  it("records a bounded manager response under the same runId and signs it", async () => {
    const result = await runManagerEscalationDemo(
      "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
      "en-GB",
    );

    expect(result.status).toBe("ESCALATION_RECORDED");
    expect(result.purchaseOrder).toBeNull();
    expect(result.managerEscalation).toMatchObject({
      runId: result.workflowId,
      effectiveDecision: "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
      evidenceStatus: "VERIFIED",
      policyChanged: false,
      orderCreated: false,
    });
    expect(result.stateHistory.map(({ to }) => to)).toEqual(
      expect.arrayContaining([
        "NO_COMPLIANT_OFFER",
        "HUMAN_ESCALATION_REQUIRED",
        "MANAGER_CALLING",
        "MANAGER_RESPONSE_RECEIVED",
        "PROOF_SIGNED",
      ]),
    );
    expect(result.signedProof?.payload.managerEscalation?.effectiveDecision).toBe(
      "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
    );
    const rejectionTrace = Object.fromEntries(
      result.decision?.rejectedOffers.map(({ offer, validation }) => [
        offer.supplierId,
        [...validation.failedCheckIds, ...validation.humanReviewCheckIds],
      ]) ?? [],
    );
    expect(rejectionTrace["supplier-de-01"]).toContain("quantity_sufficient");
    expect(rejectionTrace["supplier-fr-01"]).toContain("delivery_before_stockout");
    expect(rejectionTrace["supplier-pl-01"]).toContain("commercial_terms_unchanged");
    expect(await verifyDecisionProof(result.signedProof!)).toMatchObject({ valid: true });
  });

  it("turns a spoken budget override into authenticated human approval without changing policy", async () => {
    const result = await runManagerEscalationDemo("ATTEMPT_POLICY_OVERRIDE");

    expect(result.status).toBe("AUTHENTICATED_APPROVAL_REQUIRED");
    expect(result.purchaseOrder).toBeNull();
    expect(result.managerEscalation).toMatchObject({
      rawDecision: "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
      effectiveDecision: "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL",
      restrictedActionsRequested: ["INCREASE_BUDGET"],
      policyChanged: false,
      orderCreated: false,
    });
  });

  it("quarantines a response without verified decision evidence", async () => {
    const result = await runManagerEscalationDemo("UNVERIFIED_RESPONSE");

    expect(result.status).toBe("HUMAN_ESCALATION_REQUIRED");
    expect(result.workflowState).toBe("HUMAN_REVIEW");
    expect(result.managerEscalation).toBeNull();
    expect(result.purchaseOrder).toBeNull();
    expect(result.signedProof).toBeUndefined();
  });

  it("does not permit escalation after a compliant order was created", async () => {
    const ordered = await runDemoWorkflow(true);
    const escalation = new ManagerEscalationWorkflow(
      new MockManagerEscalationAdapter(),
    );

    await expect(
      escalation.run(
        ordered,
        { ...request, runId: ordered.workflowId },
        authorization,
      ),
    ).rejects.toThrow(
      "Manager escalation is only allowed after a no-compliant-offer outcome",
    );
  });
});
