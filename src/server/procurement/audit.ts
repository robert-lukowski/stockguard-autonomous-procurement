import { createAuditChain, sha256, type HashChainedEvent } from "../../security";

/**
 * Structured audit events for a procurement run.
 *
 * Every tool invocation, every refusal and every state change appends one
 * event. The events are then hash-chained with the existing
 * `createAuditChain`, so the Judge Portal can show tamper-evident evidence
 * using the same primitive the Decision Proof already uses.
 */
export type ProcurementAuditEventType =
  | "SESSION_STARTED"
  | "UTTERANCE_RECEIVED"
  | "REQUEST_INTERPRETED"
  | "TOOL_INVOKED"
  | "TOOL_FAILED"
  | "PRODUCT_RESOLVED"
  | "OUT_OF_DOMAIN_REJECTED"
  | "QUOTE_ISSUED"
  | "POLICY_EVALUATED"
  | "CONFIRMATION_REQUESTED"
  | "CONFIRMATION_RECEIVED"
  | "CONFIRMATION_DECLINED"
  | "PURCHASE_REQUEST_CREATED"
  | "PURCHASE_REQUEST_REPLAYED"
  | "HUMAN_APPROVAL_REQUESTED"
  | "RUN_COMPLETED";

export type ProcurementAuditEvent = {
  type: ProcurementAuditEventType;
  at: string;
  sessionId: string;
  /** Never a transcript and never free-form model output: structured facts only. */
  detail: Record<string, string | number | boolean | null>;
};

export function auditEvent(
  type: ProcurementAuditEventType,
  sessionId: string,
  at: string,
  detail: Record<string, string | number | boolean | null> = {},
): ProcurementAuditEvent {
  return { type, at, sessionId, detail };
}

export type ProcurementAuditProof = {
  chain: HashChainedEvent<ProcurementAuditEvent>[];
  rootHash: string;
};

/**
 * Hash-chains the run's audit events.
 *
 * `rootHash` is the hash of the last link, so a single value identifies the
 * whole chain; an empty run hashes the empty chain rather than throwing.
 */
export async function buildAuditProof(
  events: ProcurementAuditEvent[],
): Promise<ProcurementAuditProof> {
  const chain = await createAuditChain(events);
  return {
    chain,
    rootHash: chain.at(-1)?.hash ?? (await sha256([])),
  };
}
