import { describe, expect, it } from "vitest";
import { canonicalize, createAuditChain, createSignedDecisionProof, sha256, verifyDecisionProof } from ".";

describe("cryptographic decision proof", () => {
  it("canonicalizes object keys deterministically", () => {
    expect(canonicalize({ z: 1, a: { d: 4, b: 2 } })).toBe('{"a":{"b":2,"d":4},"z":1}');
  });

  it("creates a verifiable signed proof and detects tampering", async () => {
    const auditChain = await createAuditChain([
      { type: "STARTED", amount: 336 },
      { type: "ORDER_CREATED", supplier: "supplier-de-01" },
    ]);
    const offer = { supplierId: "supplier-de-01", totalPriceEur: 336 };
    const proof = await createSignedDecisionProof({
      workflowId: "wf-test",
      generatedAt: "2026-08-21T09:49:00.000Z",
      policyVersion: "policy-v1",
      policyHash: await sha256({ version: "policy-v1" }),
      offerHashes: { "supplier-de-01": await sha256(offer) },
      evidenceHashes: { "supplier-de-01": await sha256({ unitPrice: "VERIFIED" }) },
      selectedSupplierId: "supplier-de-01",
      selectedOfferId: "offer-1",
      passedChecks: ["budget"],
      rejectedSuppliers: [],
      ruleTrace: [
        {
          supplierId: "supplier-de-01",
          checks: [
            { id: "budget", status: "PASS", evidence: "within limit", inputs: { total: 336 } },
          ],
        },
      ],
      orderValueEur: 336,
      managerEscalation: null,
      auditChain,
    });

    expect(await verifyDecisionProof(proof)).toMatchObject({ valid: true });

    const tampered = structuredClone(proof);
    tampered.payload.orderValueEur = 1;
    expect(await verifyDecisionProof(tampered)).toMatchObject({
      valid: false,
      payloadHashValid: false,
    });
  });

  it("signs a no-order manager escalation record and detects a changed decision", async () => {
    const auditChain = await createAuditChain([
      { type: "NO_COMPLIANT_OFFER" },
      { type: "MANAGER_DECISION_RECORDED" },
    ]);
    const proof = await createSignedDecisionProof({
      workflowId: "wf-escalation",
      generatedAt: "2026-08-21T10:30:00.000Z",
      policyVersion: "policy-v1",
      policyHash: await sha256({ version: "policy-v1" }),
      offerHashes: {},
      evidenceHashes: {},
      selectedSupplierId: null,
      selectedOfferId: null,
      passedChecks: [],
      rejectedSuppliers: [],
      ruleTrace: [],
      orderValueEur: null,
      managerEscalation: {
        callIdHash: await sha256("call-1"),
        responseHash: await sha256({ decision: "REQUEST_WRITTEN_REPORT" }),
        evidenceHash: await sha256("Please send the written report"),
        rawDecision: "REQUEST_WRITTEN_REPORT",
        effectiveDecision: "REQUEST_WRITTEN_REPORT",
        preferredContactAt: null,
        restrictedActionsRequested: [],
        outcome: "ANSWERED",
        policyChanged: false,
        orderCreated: false,
      },
      auditChain,
    });

    expect(await verifyDecisionProof(proof)).toMatchObject({ valid: true });
    const tampered = structuredClone(proof);
    if (tampered.payload.managerEscalation) {
      tampered.payload.managerEscalation.effectiveDecision = "DECLINE_ESCALATION";
    }
    expect(await verifyDecisionProof(tampered)).toMatchObject({
      valid: false,
      payloadHashValid: false,
    });
  });
});
