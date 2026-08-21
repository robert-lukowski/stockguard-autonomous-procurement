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
      selectedSupplierId: "supplier-de-01",
      selectedOfferId: "offer-1",
      passedChecks: ["budget"],
      rejectedSuppliers: [],
      orderValueEur: 336,
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
});
