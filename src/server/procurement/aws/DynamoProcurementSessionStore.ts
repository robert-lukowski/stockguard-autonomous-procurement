import {
  DynamoConditionalCheckFailed,
  type DynamoDocumentPort,
} from "../../aws/dynamoDocument";
import type { ProcurementAuditEvent } from "../audit";
import {
  ProcurementSessionNotFound,
  type ConfirmationClaim,
  type ProcurementSession,
  type ProcurementSessionStore,
} from "../sessionStore";
import type {
  HumanApprovalRequest,
  PurchaseEvaluation,
  PurchaseRequest,
  RunOutcome,
  SupplierQuote,
} from "../types";

/**
 * Durable procurement sessions on DynamoDB.
 *
 * Single-table, one partition per session, reusing the conditional-write
 * patterns already proven in `src/server/judge/aws/dynamo.ts`.
 *
 *   PK = PSESSION#<sessionId>
 *   SK = METADATA                    session core, outcome, TTL
 *      | QUOTE#<quoteId>
 *      | EVAL#<evaluationId>
 *      | CONFIRM#<confirmationToken> single-use token AND its purchase request
 *      | APPROVAL#<approvalRequestId>
 *      | AUDIT#<iso>#<index>         ordered by sort key
 *
 * The session is deliberately spread across items rather than held as one
 * document. A read-modify-write of a single large item cannot make a token
 * single-use under concurrency: two instances would both read "unused" and both
 * write. Here the token IS its own item, and `attribute_not_exists(PK)` decides
 * the winner in one round trip.
 *
 * Audit sort keys carry the event timestamp, a batch-local index and a random
 * suffix, rather than a sequence counter. A counter would need its own
 * read-modify-write and could collide; ISO-8601 sorts lexicographically in the
 * order things happened, so a timestamp-ordered key needs neither.
 *
 * The random suffix exists because the index restarts at zero on every
 * `appendAudit` call. Two batches whose events share a millisecond would
 * otherwise produce the same key, and these are unconditional writes, so the
 * later batch would silently overwrite earlier audit evidence and leave an
 * incomplete hash chain. Ordering within one millisecond is then arbitrary,
 * which is acceptable; losing an event is not.
 */

const METADATA_SK = "METADATA";

function partitionKey(sessionId: string): string {
  return `PSESSION#${sessionId}`;
}

function key(sessionId: string, sortKey: string): Record<string, string> {
  return { PK: partitionKey(sessionId), SK: sortKey };
}

function epochSeconds(isoDate: string): number {
  return Math.floor(Date.parse(isoDate) / 1000);
}

function paddedIndex(index: number): string {
  return String(index).padStart(4, "0");
}

/** Enough entropy that two same-millisecond batches cannot collide. */
function uniqueSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reconstructs a typed value from a stored item.
 *
 * Everything under `payload` was written by this store, so it is parsed rather
 * than re-validated field by field. It is not user input: the tool boundary
 * validated it before it was ever written.
 */
function payloadOf<T>(item: Record<string, unknown>): T {
  return structuredClone(item.payload) as T;
}

export class DynamoProcurementSessionStore implements ProcurementSessionStore {
  constructor(
    private readonly client: DynamoDocumentPort,
    private readonly tableName: string,
  ) {}

  async create(session: ProcurementSession): Promise<"CREATED" | "DUPLICATE"> {
    try {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...key(session.sessionId, METADATA_SK),
          entityType: "ProcurementSession",
          sessionId: session.sessionId,
          missionId: session.missionId,
          channel: session.channel,
          startedAt: session.startedAt,
          expiresAt: session.expiresAt,
          outcome: null,
          completedAt: null,
          expiresAtEpoch: epochSeconds(session.expiresAt),
        },
        conditionExpression: "attribute_not_exists(#pk)",
        expressionAttributeNames: { "#pk": "PK" },
      });
    } catch (error) {
      if (error instanceof DynamoConditionalCheckFailed) return "DUPLICATE";
      throw error;
    }

    if (session.audit.length > 0) {
      await this.appendAudit(session.sessionId, session.audit);
    }
    return "CREATED";
  }

  async get(sessionId: string): Promise<ProcurementSession | null> {
    const result = await this.client.execute({
      operation: "Query",
      tableName: this.tableName,
      keyConditionExpression: "#pk = :pk",
      expressionAttributeNames: { "#pk": "PK" },
      expressionAttributeValues: { ":pk": partitionKey(sessionId) },
      consistentRead: true,
    });

    const items = result.items ?? [];
    const metadata = items.find((item) => item.SK === METADATA_SK);
    if (!metadata) return null;

    const session: ProcurementSession = {
      sessionId: String(metadata.sessionId),
      missionId: String(metadata.missionId),
      channel: String(metadata.channel),
      startedAt: String(metadata.startedAt),
      expiresAt: String(metadata.expiresAt),
      outcome: (metadata.outcome as RunOutcome | null) ?? null,
      completedAt:
        typeof metadata.completedAt === "string" ? metadata.completedAt : null,
      quotes: {},
      evaluations: {},
      purchaseRequestsByToken: {},
      approvals: {},
      audit: [],
    };

    for (const item of items) {
      const sortKey = String(item.SK);
      if (sortKey.startsWith("QUOTE#")) {
        const quote = payloadOf<SupplierQuote>(item);
        session.quotes[quote.quoteId] = quote;
      } else if (sortKey.startsWith("EVAL#")) {
        const evaluation = payloadOf<PurchaseEvaluation>(item);
        session.evaluations[evaluation.evaluationId] = evaluation;
      } else if (sortKey.startsWith("CONFIRM#")) {
        session.purchaseRequestsByToken[String(item.confirmationToken)] =
          payloadOf<PurchaseRequest>(item);
      } else if (sortKey.startsWith("APPROVAL#")) {
        const approval = payloadOf<HumanApprovalRequest>(item);
        session.approvals[approval.approvalRequestId] = approval;
      } else if (sortKey.startsWith("AUDIT#")) {
        session.audit.push(payloadOf<ProcurementAuditEvent>(item));
      }
    }

    /*
     * Query returns items in sort-key order, so audit events already arrive in
     * the order they happened. Sorting again costs nothing and means the hash
     * chain does not silently depend on that guarantee.
     */
    session.audit.sort((left, right) => left.at.localeCompare(right.at));
    return session;
  }

  private async requireSessionTtl(sessionId: string): Promise<number> {
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: key(sessionId, METADATA_SK),
      consistentRead: true,
    });
    if (!result.item) throw new ProcurementSessionNotFound(sessionId);
    return Number(result.item.expiresAtEpoch);
  }

  /**
   * Every child item inherits the session's TTL.
   *
   * A quote or an audit event that outlived its session would leave orphaned
   * rows that no read path can reach and no retention policy would clean up.
   */
  private async putChild(
    sessionId: string,
    sortKey: string,
    entityType: string,
    payload: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const expiresAtEpoch = await this.requireSessionTtl(sessionId);
    await this.client.execute({
      operation: "Put",
      tableName: this.tableName,
      item: {
        ...key(sessionId, sortKey),
        entityType,
        sessionId,
        payload: structuredClone(payload),
        expiresAtEpoch,
        ...extra,
      },
    });
  }

  async appendAudit(sessionId: string, events: ProcurementAuditEvent[]): Promise<void> {
    if (events.length === 0) return;
    const expiresAtEpoch = await this.requireSessionTtl(sessionId);
    const batch = uniqueSuffix();
    for (const [index, event] of events.entries()) {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...key(sessionId, `AUDIT#${event.at}#${paddedIndex(index)}#${batch}`),
          entityType: "ProcurementAuditEvent",
          sessionId,
          payload: structuredClone(event),
          expiresAtEpoch,
        },
      });
    }
  }

  async putQuote(sessionId: string, quote: SupplierQuote): Promise<void> {
    await this.putChild(sessionId, `QUOTE#${quote.quoteId}`, "SupplierQuote", quote);
  }

  async putEvaluation(sessionId: string, evaluation: PurchaseEvaluation): Promise<void> {
    await this.putChild(
      sessionId,
      `EVAL#${evaluation.evaluationId}`,
      "PurchaseEvaluation",
      evaluation,
    );
  }

  /**
   * Consumes the confirmation token by creating its item, or reports the
   * request that already consumed it.
   *
   * This is the single-use guarantee, and it is one conditional write: the
   * token item either does not exist and this call creates it, or it exists and
   * this call reads back whatever purchase request was created first. There is
   * no window in which two callers both see "unused".
   */
  async claimConfirmation(
    sessionId: string,
    confirmationToken: string,
    request: PurchaseRequest,
  ): Promise<ConfirmationClaim> {
    const expiresAtEpoch = await this.requireSessionTtl(sessionId);
    const sortKey = `CONFIRM#${confirmationToken}`;
    try {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...key(sessionId, sortKey),
          entityType: "PurchaseRequest",
          sessionId,
          confirmationToken,
          payload: structuredClone(request),
          expiresAtEpoch,
        },
        conditionExpression: "attribute_not_exists(#pk)",
        expressionAttributeNames: { "#pk": "PK" },
      });
      return { kind: "CLAIMED", request: structuredClone(request) };
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
      const existing = await this.client.execute({
        operation: "Get",
        tableName: this.tableName,
        key: key(sessionId, sortKey),
        consistentRead: true,
      });
      if (!existing.item) {
        /*
         * The condition failed but the item is gone: it expired between the two
         * calls. Fail closed rather than retrying the create, because a retry
         * would be indistinguishable from creating a second purchase request.
         */
        throw new Error(
          `Confirmation token for session ${sessionId} could not be resolved after a conditional failure`,
        );
      }
      return { kind: "DUPLICATE", request: payloadOf<PurchaseRequest>(existing.item) };
    }
  }

  async putApproval(sessionId: string, approval: HumanApprovalRequest): Promise<void> {
    await this.putChild(
      sessionId,
      `APPROVAL#${approval.approvalRequestId}`,
      "HumanApprovalRequest",
      approval,
    );
  }

  /**
   * Completes the run exactly once.
   *
   * Conditional on the outcome still being unset, so a replayed confirmation or
   * a concurrent request gets ALREADY_COMPLETED and emits no metrics.
   */
  async complete(
    sessionId: string,
    outcome: RunOutcome,
    completedAt: string,
  ): Promise<"COMPLETED" | "ALREADY_COMPLETED"> {
    try {
      await this.client.execute({
        operation: "Update",
        tableName: this.tableName,
        key: key(sessionId, METADATA_SK),
        updateExpression: "SET #outcome = :outcome, #completedAt = :completedAt",
        conditionExpression: "attribute_exists(#pk) AND #outcome = :unset",
        expressionAttributeNames: {
          "#pk": "PK",
          "#outcome": "outcome",
          "#completedAt": "completedAt",
        },
        expressionAttributeValues: {
          ":outcome": outcome,
          ":completedAt": completedAt,
          ":unset": null,
        },
      });
      return "COMPLETED";
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
      const current = await this.client.execute({
        operation: "Get",
        tableName: this.tableName,
        key: key(sessionId, METADATA_SK),
        consistentRead: true,
      });
      if (!current.item) throw new ProcurementSessionNotFound(sessionId);
      return "ALREADY_COMPLETED";
    }
  }
}
