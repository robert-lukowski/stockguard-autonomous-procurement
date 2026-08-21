import type {
  CallClaimInput,
  CallClaimResult,
  GlobalCallBudget,
  JudgeSessionStore,
  JudgeWebhookEventStore,
  SessionRateLimiter,
  StoredCallClaim,
  StoredJudgeSession,
} from "../backend";
import {
  DynamoConditionalCheckFailed,
  type DynamoDocumentPort,
} from "../../aws/dynamoDocument";

export {
  DynamoConditionalCheckFailed,
  type DynamoCommand,
  type DynamoCommandResult,
  type DynamoDocumentPort,
} from "../../aws/dynamoDocument";

function sessionKey(sessionId: string): Record<string, string> {
  return { PK: `SESSION#${sessionId}`, SK: "METADATA" };
}

function toSession(item: Record<string, unknown>): StoredJudgeSession {
  return {
    sessionId: String(item.sessionId),
    tokenHash: String(item.tokenHash),
    issuedAt: String(item.issuedAt),
    expiresAt: String(item.expiresAt),
    status: item.status as StoredJudgeSession["status"],
    claims:
      typeof item.claims === "object" && item.claims !== null
        ? (structuredClone(item.claims) as StoredJudgeSession["claims"])
        : {},
  };
}

function classifySession(
  session: StoredJudgeSession | null,
  input: CallClaimInput,
): CallClaimResult | null {
  if (!session) return { kind: "NOT_FOUND" };
  if (session.tokenHash !== input.tokenHash) return { kind: "TOKEN_INVALID" };
  if (session.status === "REVOKED") return { kind: "REVOKED" };
  if (Date.parse(session.expiresAt) <= Date.parse(input.now)) return { kind: "EXPIRED" };
  const existing = session.claims[input.idempotencyKey];
  if (existing) {
    return { kind: "DUPLICATE", session, claim: structuredClone(existing) };
  }
  if (session.status === "CONSUMED" || Object.keys(session.claims).length > 0) {
    return { kind: "CONSUMED" };
  }
  return null;
}

export class DynamoJudgeSessionStore implements JudgeSessionStore {
  constructor(
    private readonly client: DynamoDocumentPort,
    private readonly tableName: string,
  ) {}

  private async get(sessionId: string): Promise<StoredJudgeSession | null> {
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: sessionKey(sessionId),
      consistentRead: true,
    });
    return result.item ? toSession(result.item) : null;
  }

  async create(session: StoredJudgeSession): Promise<void> {
    await this.client.execute({
      operation: "Put",
      tableName: this.tableName,
      item: {
        ...sessionKey(session.sessionId),
        entityType: "JudgeSession",
        ...structuredClone(session),
        expiresAtEpoch: Math.floor(Date.parse(session.expiresAt) / 1000),
      },
      conditionExpression: "attribute_not_exists(#pk)",
      expressionAttributeNames: { "#pk": "PK" },
    });
  }

  async claimCall(input: CallClaimInput): Promise<CallClaimResult> {
    const current = await this.get(input.sessionId);
    const classified = classifySession(current, input);
    if (classified) return classified;
    if (!current) return { kind: "NOT_FOUND" };

    const claim: StoredCallClaim = {
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      phoneHash: input.phoneHash,
      locale: input.locale,
      consentRecordedAt: input.consentRecordedAt,
      status: "PENDING",
      callTaskId: null,
    };
    try {
      await this.client.execute({
        operation: "Update",
        tableName: this.tableName,
        key: sessionKey(input.sessionId),
        updateExpression: "SET #status = :consumed, #claims.#claim = :claim",
        conditionExpression:
          "#status = :active AND #tokenHash = :tokenHash AND #expiresAtEpoch > :nowEpoch AND attribute_not_exists(#claims.#claim)",
        expressionAttributeNames: {
          "#status": "status",
          "#tokenHash": "tokenHash",
          "#expiresAtEpoch": "expiresAtEpoch",
          "#claims": "claims",
          "#claim": input.idempotencyKey,
        },
        expressionAttributeValues: {
          ":consumed": "CONSUMED",
          ":active": "ACTIVE",
          ":tokenHash": input.tokenHash,
          ":nowEpoch": Math.floor(Date.parse(input.now) / 1000),
          ":claim": claim,
        },
      });
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
      return classifySession(await this.get(input.sessionId), input) ?? {
        kind: "CONSUMED",
      };
    }

    const session: StoredJudgeSession = {
      ...current,
      status: "CONSUMED",
      claims: { ...current.claims, [input.idempotencyKey]: claim },
    };
    return { kind: "CLAIMED", session, claim };
  }

  async completeClaim(
    sessionId: string,
    idempotencyKey: string,
    update: Pick<StoredCallClaim, "status" | "callTaskId">,
  ): Promise<void> {
    await this.client.execute({
      operation: "Update",
      tableName: this.tableName,
      key: sessionKey(sessionId),
      updateExpression:
        "SET #claims.#claim.#status = :status, #claims.#claim.#callTaskId = :callTaskId",
      conditionExpression: "attribute_exists(#claims.#claim)",
      expressionAttributeNames: {
        "#claims": "claims",
        "#claim": idempotencyKey,
        "#status": "status",
        "#callTaskId": "callTaskId",
      },
      expressionAttributeValues: {
        ":status": update.status,
        ":callTaskId": update.callTaskId,
      },
    });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.client.execute({
      operation: "Update",
      tableName: this.tableName,
      key: sessionKey(sessionId),
      updateExpression: "SET #status = :revoked",
      conditionExpression: "attribute_exists(#pk)",
      expressionAttributeNames: { "#status": "status", "#pk": "PK" },
      expressionAttributeValues: { ":revoked": "REVOKED" },
    });
  }
}
abstract class DynamoCounter {
  constructor(
    protected readonly client: DynamoDocumentPort,
    protected readonly tableName: string,
  ) {}

  protected async increment(
    key: Record<string, unknown>,
    maximum: number,
    expiresAtEpoch?: number,
  ): Promise<boolean> {
    try {
      await this.client.execute({
        operation: "Update",
        tableName: this.tableName,
        key,
        updateExpression:
          "SET #used = if_not_exists(#used, :zero) + :one" +
          (expiresAtEpoch ? ", #expiresAtEpoch = :expiresAtEpoch" : ""),
        conditionExpression: "attribute_not_exists(#used) OR #used < :maximum",
        expressionAttributeNames: {
          "#used": "used",
          ...(expiresAtEpoch ? { "#expiresAtEpoch": "expiresAtEpoch" } : {}),
        },
        expressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":maximum": maximum,
          ...(expiresAtEpoch ? { ":expiresAtEpoch": expiresAtEpoch } : {}),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof DynamoConditionalCheckFailed) return false;
      throw error;
    }
  }
}

export class DynamoGlobalCallBudget extends DynamoCounter implements GlobalCallBudget {
  constructor(
    client: DynamoDocumentPort,
    tableName: string,
    private readonly budgetId: string,
    private readonly maximumCalls: number,
  ) {
    super(client, tableName);
  }

  async claim(): Promise<boolean> {
    return this.increment(
      { PK: `BUDGET#${this.budgetId}`, SK: "COUNTER" },
      this.maximumCalls,
    );
  }
}

export class DynamoFixedWindowRateLimiter
  extends DynamoCounter
  implements SessionRateLimiter
{
  constructor(
    client: DynamoDocumentPort,
    tableName: string,
    private readonly maximumAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {
    super(client, tableName);
  }

  async allow(key: string, now: Date): Promise<boolean> {
    const bucket = Math.floor(now.getTime() / this.windowMs);
    const expiresAtEpoch = Math.floor((bucket + 2) * this.windowMs / 1000);
    return this.increment(
      { PK: `RATE#${key}`, SK: `WINDOW#${bucket}` },
      this.maximumAttempts,
      expiresAtEpoch,
    );
  }
}

export class DynamoJudgeWebhookEventStore implements JudgeWebhookEventStore {
  constructor(
    private readonly client: DynamoDocumentPort,
    private readonly tableName: string,
    private readonly ttlSeconds = 24 * 60 * 60,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async claim(eventId: string, bodyHash: string): Promise<"ACCEPTED" | "DUPLICATE" | "CONFLICT"> {
    const key = { PK: `WEBHOOK#${eventId}`, SK: "EVENT" };
    try {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...key,
          entityType: "WebhookEvent",
          eventId,
          bodyHash,
          expiresAtEpoch: Math.floor(this.clock().getTime() / 1000) + this.ttlSeconds,
        },
        conditionExpression: "attribute_not_exists(#pk)",
        expressionAttributeNames: { "#pk": "PK" },
      });
      return "ACCEPTED";
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
      const existing = await this.client.execute({
        operation: "Get",
        tableName: this.tableName,
        key,
        consistentRead: true,
      });
      return existing.item?.bodyHash === bodyHash ? "DUPLICATE" : "CONFLICT";
    }
  }
}
