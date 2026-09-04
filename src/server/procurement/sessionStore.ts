import type { ProcurementAuditEvent } from "./audit";
import type {
  HumanApprovalRequest,
  PurchaseEvaluation,
  PurchaseRequest,
  RunOutcome,
  SupplierQuote,
} from "./types";

/**
 * Durable procurement session state.
 *
 * The port is deliberately granular rather than a `save(session)` of one large
 * object. Read-modify-write of a whole session cannot express the two
 * guarantees this system actually needs:
 *
 *   - a confirmation token is consumed EXACTLY once, even if two requests
 *     arrive at the same moment on different instances;
 *   - a run completes exactly once, so metrics cannot be double-counted.
 *
 * Both are conditional writes on their own item. Every implementation must
 * provide them atomically; the in-memory one below does so within a process,
 * and `DynamoProcurementSessionStore` does so across instances.
 */

export type ProcurementSessionCore = {
  sessionId: string;
  missionId: string;
  channel: string;
  startedAt: string;
  expiresAt: string;
  outcome: RunOutcome | null;
  completedAt: string | null;
};

export type ProcurementSession = ProcurementSessionCore & {
  quotes: Record<string, SupplierQuote>;
  evaluations: Record<string, PurchaseEvaluation>;
  /** Purchase requests keyed by the single-use confirmation token. */
  purchaseRequestsByToken: Record<string, PurchaseRequest>;
  approvals: Record<string, HumanApprovalRequest>;
  audit: ProcurementAuditEvent[];
};

/**
 * The outcome of consuming a confirmation token.
 *
 * `DUPLICATE` is a success, not an error: a judge who submits twice must get
 * the original purchase request back, never a second one and never a failure.
 */
export type ConfirmationClaim =
  | { kind: "CLAIMED"; request: PurchaseRequest }
  | { kind: "DUPLICATE"; request: PurchaseRequest };

export interface ProcurementSessionStore {
  create(session: ProcurementSession): Promise<"CREATED" | "DUPLICATE">;
  get(sessionId: string): Promise<ProcurementSession | null>;
  appendAudit(sessionId: string, events: ProcurementAuditEvent[]): Promise<void>;
  putQuote(sessionId: string, quote: SupplierQuote): Promise<void>;
  putEvaluation(sessionId: string, evaluation: PurchaseEvaluation): Promise<void>;
  /** Atomic single-use consumption. Must never create two requests for one token. */
  claimConfirmation(
    sessionId: string,
    confirmationToken: string,
    request: PurchaseRequest,
  ): Promise<ConfirmationClaim>;
  putApproval(sessionId: string, approval: HumanApprovalRequest): Promise<void>;
  /** Idempotent. Only the first call may report COMPLETED. */
  complete(
    sessionId: string,
    outcome: RunOutcome,
    completedAt: string,
  ): Promise<"COMPLETED" | "ALREADY_COMPLETED">;
}

export class ProcurementSessionNotFound extends Error {
  constructor(sessionId: string) {
    super(`Procurement session ${sessionId} does not exist`);
    this.name = "ProcurementSessionNotFound";
  }
}

/**
 * Per-process session storage, for local development and tests.
 *
 * SCOPE, stated plainly: this Map lives in one process. It is NOT durable, NOT
 * a global rate limit and NOT a cross-instance idempotency control. On Lambda
 * it does not survive a cold start and is not shared across concurrent
 * containers.
 *
 * What it IS: a faithful single-process implementation of the same contract
 * `DynamoProcurementSessionStore` implements durably, including the two
 * atomicity guarantees above. Every test that exercises token reuse or replay
 * runs against both, so the two cannot drift.
 */
export class InMemoryProcurementSessionStore implements ProcurementSessionStore {
  private readonly sessions = new Map<string, ProcurementSession>();

  async create(session: ProcurementSession): Promise<"CREATED" | "DUPLICATE"> {
    if (this.sessions.has(session.sessionId)) return "DUPLICATE";
    this.sessions.set(session.sessionId, structuredClone(session));
    return "CREATED";
  }

  async get(sessionId: string): Promise<ProcurementSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  private require(sessionId: string): ProcurementSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProcurementSessionNotFound(sessionId);
    return session;
  }

  async appendAudit(sessionId: string, events: ProcurementAuditEvent[]): Promise<void> {
    this.require(sessionId).audit.push(...structuredClone(events));
  }

  async putQuote(sessionId: string, quote: SupplierQuote): Promise<void> {
    this.require(sessionId).quotes[quote.quoteId] = structuredClone(quote);
  }

  async putEvaluation(sessionId: string, evaluation: PurchaseEvaluation): Promise<void> {
    this.require(sessionId).evaluations[evaluation.evaluationId] =
      structuredClone(evaluation);
  }

  async claimConfirmation(
    sessionId: string,
    confirmationToken: string,
    request: PurchaseRequest,
  ): Promise<ConfirmationClaim> {
    const session = this.require(sessionId);
    const existing = session.purchaseRequestsByToken[confirmationToken];
    if (existing) return { kind: "DUPLICATE", request: structuredClone(existing) };
    session.purchaseRequestsByToken[confirmationToken] = structuredClone(request);
    return { kind: "CLAIMED", request: structuredClone(request) };
  }

  async putApproval(sessionId: string, approval: HumanApprovalRequest): Promise<void> {
    this.require(sessionId).approvals[approval.approvalRequestId] =
      structuredClone(approval);
  }

  async complete(
    sessionId: string,
    outcome: RunOutcome,
    completedAt: string,
  ): Promise<"COMPLETED" | "ALREADY_COMPLETED"> {
    const session = this.require(sessionId);
    if (session.outcome !== null) return "ALREADY_COMPLETED";
    session.outcome = outcome;
    session.completedAt = completedAt;
    return "COMPLETED";
  }
}
