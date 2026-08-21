import { canonicalize, CANONICALIZATION_VERSION } from "./canonicalJson";

const encoder = new TextEncoder();

export type HashChainedEvent<T = unknown> = {
  sequence: number;
  previousHash: string;
  payload: T;
  hash: string;
};

export type DecisionProofPayload = {
  schemaVersion: "stockguard-decision-proof-v2";
  canonicalization: typeof CANONICALIZATION_VERSION;
  workflowId: string;
  generatedAt: string;
  policyVersion: string;
  policyHash: string;
  offerHashes: Record<string, string>;
  evidenceHashes: Record<string, string>;
  selectedSupplierId: string | null;
  selectedOfferId: string | null;
  passedChecks: string[];
  rejectedSuppliers: Array<{
    supplierId: string;
    failedChecks: string[];
    requiresHumanChecks: string[];
  }>;
  ruleTrace: Array<{
    supplierId: string;
    checks: Array<{
      id: string;
      status: "PASS" | "FAIL" | "REQUIRES_HUMAN";
      evidence: string;
      inputs: Record<string, string | number | boolean | null>;
    }>;
  }>;
  orderValueEur: number | null;
  managerEscalation: {
    callIdHash: string;
    responseHash: string;
    evidenceHash: string;
    rawDecision: string;
    effectiveDecision: string;
    preferredContactAt: string | null;
    restrictedActionsRequested: string[];
    outcome: string;
    policyChanged: false;
    orderCreated: false;
  } | null;
  auditChain: HashChainedEvent[];
  auditRootHash: string;
};

export type SignedDecisionProof = {
  payload: DecisionProofPayload;
  payloadHash: string;
  signature: string;
  signatureAlgorithm: "ECDSA_P256_SHA256";
  publicKeyJwk: JsonWebKey;
  signer: {
    mode: "ephemeral-browser-demo";
    keyId: string;
  };
};

export type ProofVerification = {
  valid: boolean;
  payloadHashValid: boolean;
  signatureValid: boolean;
  auditChainValid: boolean;
  reason: string;
};

export type ProofSignature = Pick<
  SignedDecisionProof,
  "signature" | "signatureAlgorithm" | "publicKeyJwk" | "signer"
>;

export interface ProofSigner {
  sign(payloadHash: string): Promise<ProofSignature>;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalize(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAuditChain<T>(events: T[]): Promise<HashChainedEvent<T>[]> {
  const chain: HashChainedEvent<T>[] = [];
  let previousHash = "GENESIS";

  for (const [index, payload] of events.entries()) {
    const sequence = index + 1;
    const hash = await sha256({ sequence, previousHash, payload });
    chain.push({ sequence, previousHash, payload, hash });
    previousHash = hash;
  }

  return chain;
}

export async function createSignedDecisionProof(
  payload: Omit<DecisionProofPayload, "canonicalization" | "schemaVersion" | "auditRootHash"> & {
    auditChain: HashChainedEvent[];
  },
  signer: ProofSigner = new EphemeralWebCryptoSigner(),
): Promise<SignedDecisionProof> {
  const completePayload: DecisionProofPayload = {
    ...payload,
    schemaVersion: "stockguard-decision-proof-v2",
    canonicalization: CANONICALIZATION_VERSION,
    auditRootHash: payload.auditChain.at(-1)?.hash ?? "GENESIS",
  };
  const payloadHash = await sha256(completePayload);
  return {
    payload: completePayload,
    payloadHash,
    ...(await signer.sign(payloadHash)),
  };
}

export class EphemeralWebCryptoSigner implements ProofSigner {
  async sign(payloadHash: string): Promise<ProofSignature> {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      encoder.encode(payloadHash),
    );
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    return {
      signature: bytesToBase64(signature),
      signatureAlgorithm: "ECDSA_P256_SHA256",
      publicKeyJwk,
      signer: { mode: "ephemeral-browser-demo", keyId: `demo:${payloadHash.slice(0, 12)}` },
    };
  }
}

export async function verifyDecisionProof(proof: SignedDecisionProof): Promise<ProofVerification> {
  const recalculatedPayloadHash = await sha256(proof.payload);
  const payloadHashValid = recalculatedPayloadHash === proof.payloadHash;
  let previousHash = "GENESIS";
  let auditChainValid = true;

  for (const event of proof.payload.auditChain) {
    const expected = await sha256({
      sequence: event.sequence,
      previousHash,
      payload: event.payload,
    });
    if (event.previousHash !== previousHash || event.hash !== expected) auditChainValid = false;
    previousHash = event.hash;
  }
  auditChainValid = auditChainValid && previousHash === proof.payload.auditRootHash;

  let signatureValid = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      proof.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64ToBytes(proof.signature),
      encoder.encode(proof.payloadHash),
    );
  } catch {
    signatureValid = false;
  }

  const valid = payloadHashValid && signatureValid && auditChainValid;
  return {
    valid,
    payloadHashValid,
    signatureValid,
    auditChainValid,
    reason: valid
      ? "Signature valid — audit chain intact"
      : "Verification failed — the decision record has been modified",
  };
}
