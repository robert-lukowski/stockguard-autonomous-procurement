import { describe, expect, it } from "vitest";
import type { StoredJudgeSession } from "../backend";
import {
  DynamoConditionalCheckFailed,
  DynamoFixedWindowRateLimiter,
  DynamoGlobalCallBudget,
  DynamoJudgeSessionStore,
  DynamoJudgeWebhookEventStore,
  type DynamoCommand,
  type DynamoCommandResult,
  type DynamoDocumentPort,
} from ".";

class QueueDynamoClient implements DynamoDocumentPort {
  readonly commands: DynamoCommand[] = [];

  constructor(
    private readonly outcomes: Array<DynamoCommandResult | Error> = [],
  ) {}

  async execute(command: DynamoCommand): Promise<DynamoCommandResult> {
    this.commands.push(structuredClone(command));
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? {};
  }
}

const session: StoredJudgeSession = {
  sessionId: "session-1",
  runId: "run-1",
  tokenHash: "token-hash",
  issuedAt: "2026-08-21T10:00:00Z",
  expiresAt: "2026-08-21T10:15:00Z",
  status: "ACTIVE",
  claims: {},
};

const claimInput = {
  sessionId: session.sessionId,
  tokenHash: session.tokenHash,
  idempotencyKey: "idempotency-1",
  runId: "run-1",
  phoneHash: "phone-hash",
  locale: "pl-PL" as const,
  consentRecordedAt: "2026-08-21T10:01:00Z",
  now: "2026-08-21T10:01:00Z",
};

function sessionItem(overrides: Partial<StoredJudgeSession> = {}) {
  return {
    PK: "SESSION#session-1",
    SK: "METADATA",
    entityType: "JudgeSession",
    ...session,
    ...overrides,
    expiresAtEpoch: 1787307300,
  };
}

describe("DynamoJudgeSessionStore", () => {
  it("creates a TTL session only when the primary key does not exist", async () => {
    const client = new QueueDynamoClient();
    const store = new DynamoJudgeSessionStore(client, "judge-table");

    await store.create(session);

    expect(client.commands[0]).toMatchObject({
      operation: "Put",
      tableName: "judge-table",
      conditionExpression: "attribute_not_exists(#pk)",
      item: expect.objectContaining({
        PK: "SESSION#session-1",
        expiresAtEpoch: expect.any(Number),
        tokenHash: "token-hash",
      }),
    });
  });

  it("claims one call with a conditional token, status, expiry and idempotency check", async () => {
    const client = new QueueDynamoClient([{ item: sessionItem() }, {}]);
    const store = new DynamoJudgeSessionStore(client, "judge-table");

    const result = await store.claimCall(claimInput);

    expect(result.kind).toBe("CLAIMED");
    const update = client.commands[1];
    expect(update).toMatchObject({
      operation: "Update",
      conditionExpression: expect.stringContaining("#status = :active"),
      expressionAttributeNames: expect.objectContaining({
        "#claim": "idempotency-1",
      }),
      expressionAttributeValues: expect.objectContaining({
        ":tokenHash": "token-hash",
        ":claim": expect.objectContaining({ phoneHash: "phone-hash" }),
      }),
    });
    expect(JSON.stringify(update)).not.toContain("+48500100200");
  });

  it("returns the existing claim after a conditional race instead of starting twice", async () => {
    const existingClaim = {
      idempotencyKey: claimInput.idempotencyKey,
      runId: claimInput.runId,
      phoneHash: claimInput.phoneHash,
      locale: claimInput.locale,
      consentRecordedAt: claimInput.consentRecordedAt,
      status: "QUEUED" as const,
      callTaskId: "call-1",
    };
    const client = new QueueDynamoClient([
      { item: sessionItem() },
      new DynamoConditionalCheckFailed("race"),
      {
        item: sessionItem({
          status: "CONSUMED",
          claims: { [claimInput.idempotencyKey]: existingClaim },
        }),
      },
    ]);
    const store = new DynamoJudgeSessionStore(client, "judge-table");

    const result = await store.claimCall(claimInput);

    expect(result).toMatchObject({
      kind: "DUPLICATE",
      claim: { callTaskId: "call-1" },
    });
  });

  it("does not write when the bearer token hash is invalid", async () => {
    const client = new QueueDynamoClient([{ item: sessionItem() }]);
    const store = new DynamoJudgeSessionStore(client, "judge-table");

    const result = await store.claimCall({
      ...claimInput,
      tokenHash: "wrong-token-hash",
    });

    expect(result.kind).toBe("TOKEN_INVALID");
    expect(client.commands).toHaveLength(1);
  });
});

describe("Dynamo conditional counters and webhook events", () => {
  it("uses a bounded TTL window for the persistent authorization rate limit", async () => {
    const client = new QueueDynamoClient();
    const limiter = new DynamoFixedWindowRateLimiter(
      client,
      "judge-table",
      5,
      15 * 60 * 1000,
    );

    expect(await limiter.allow("requester-hash", new Date("2026-08-21T10:01:00Z"))).toBe(true);
    expect(client.commands[0]).toMatchObject({
      operation: "Update",
      key: {
        PK: "RATE#requester-hash",
        SK: expect.stringMatching(/^WINDOW#\d+$/),
      },
      expressionAttributeValues: expect.objectContaining({
        ":maximum": 5,
        ":expiresAtEpoch": expect.any(Number),
      }),
    });
  });

  it("returns false when the global call budget conditional write is rejected", async () => {
    const client = new QueueDynamoClient([
      new DynamoConditionalCheckFailed("budget exhausted"),
    ]);
    const budget = new DynamoGlobalCallBudget(
      client,
      "judge-table",
      "hackathon-2026",
      25,
    );

    expect(await budget.claim()).toBe(false);
    expect(client.commands[0]).toMatchObject({
      operation: "Update",
      conditionExpression: "attribute_not_exists(#used) OR #used < :maximum",
    });
  });

  it("deduplicates a persistent webhook ID by comparing the stored body hash", async () => {
    const client = new QueueDynamoClient([
      new DynamoConditionalCheckFailed("event exists"),
      { item: { bodyHash: "same-hash" } },
    ]);
    const events = new DynamoJudgeWebhookEventStore(
      client,
      "judge-table",
      3600,
      () => new Date("2026-08-21T10:00:00Z"),
    );

    expect(await events.claim("event-1", "same-hash")).toBe("DUPLICATE");
    expect(client.commands[0]).toMatchObject({
      operation: "Put",
      conditionExpression: "attribute_not_exists(#pk)",
    });
    expect(client.commands[1]).toMatchObject({
      operation: "Get",
      consistentRead: true,
    });
  });
});
