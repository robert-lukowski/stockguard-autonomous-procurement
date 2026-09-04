import type { ProcurementAuditEvent } from "./audit";
import type {
  HumanApprovalRequest,
  PurchaseEvaluation,
  PurchaseRequest,
  RunOutcome,
  SupplierQuote,
} from "./types";

export type ProcurementSession = {
  sessionId: string;
  missionId: string;
  channel: string;
  startedAt: string;
  expiresAt: string;
  quotes: Record<string, SupplierQuote>;
  evaluations: Record<string, PurchaseEvaluation>;
  /** Purchase requests keyed by the confirmation token that created them. */
  purchaseRequestsByToken: Record<string, PurchaseRequest>;
  approvals: Record<string, HumanApprovalRequest>;
  audit: ProcurementAuditEvent[];
  outcome: RunOutcome | null;
  completedAt: string | null;
};

export interface ProcurementSessionStore {
  create(session: ProcurementSession): "CREATED" | "DUPLICATE";
  get(sessionId: string): ProcurementSession | null;
  save(session: ProcurementSession): void;
}

/**
 * Per-process session storage.
 *
 * SCOPE, stated plainly because the repository has been bitten by this before:
 * this Map lives in one process. It is NOT a durable store, NOT a global rate
 * limit, and NOT a cross-instance idempotency control. On Lambda it does not
 * survive a cold start and is not shared across concurrent containers.
 *
 * What it IS: a correct single-process implementation of the same interface a
 * DynamoDB-backed store will implement, so the orchestrator's replay and
 * single-use-token logic is exercised by tests today and needs no change when
 * the durable adapter (see `src/server/judge/aws/dynamo.ts` for the
 * conditional-write pattern) is wired in.
 */
export class InMemoryProcurementSessionStore implements ProcurementSessionStore {
  private readonly sessions = new Map<string, ProcurementSession>();

  create(session: ProcurementSession): "CREATED" | "DUPLICATE" {
    if (this.sessions.has(session.sessionId)) return "DUPLICATE";
    this.sessions.set(session.sessionId, structuredClone(session));
    return "CREATED";
  }

  get(sessionId: string): ProcurementSession | null {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  save(session: ProcurementSession): void {
    this.sessions.set(session.sessionId, structuredClone(session));
  }
}
