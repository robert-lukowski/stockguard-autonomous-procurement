import { describe, expect, it } from "vitest";
import {
  DynamoConditionalCheckFailed,
  type DynamoCommand,
  type DynamoCommandResult,
  type DynamoDocumentPort,
} from "../aws/dynamoDocument";
import {
  DynamoSyntheticSupplierStore,
  syntheticSupplierProfiles,
  type SyntheticRfq,
} from ".";

class QueueDynamoClient implements DynamoDocumentPort {
  readonly commands: DynamoCommand[] = [];

  constructor(
    private readonly results: Array<DynamoCommandResult | Error> = [],
  ) {}

  async execute(command: DynamoCommand): Promise<DynamoCommandResult> {
    this.commands.push(structuredClone(command));
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? {};
  }
}

const now = () => new Date("2026-08-21T09:00:00Z");
const rfq: SyntheticRfq = {
  runId: "run-081",
  rfqId: "RFQ-DE-081",
  routingCode: "281001",
  profileId: "DE_SUPPLIER",
  datasetVersion: "synthetic-suppliers-2026-08-v1",
  sku: "CF-220",
  requestedQuantity: 1_000,
  requiredBy: "2026-08-28T10:00:00Z",
  expiresAt: "2026-08-21T10:00:00Z",
};

describe("DynamoSyntheticSupplierStore", () => {
  it("atomically creates RFQ and routing lookup records with a short TTL", async () => {
    const client = new QueueDynamoClient();
    const store = new DynamoSyntheticSupplierStore(client, "stockguard-test", now);

    await expect(store.createRfq(rfq)).resolves.toBe("CREATED");

    expect(client.commands[0]).toMatchObject({
      operation: "TransactWrite",
      items: [
        {
          operation: "Put",
          tableName: "stockguard-test",
          item: {
            PK: "SYNTHETIC_RFQ#RFQ-DE-081",
            routingCode: "281001",
            expiresAtEpoch: 1787306400,
          },
        },
        {
          operation: "Put",
          item: { PK: "SYNTHETIC_ROUTING#281001", rfqId: "RFQ-DE-081" },
        },
      ],
    });
  });

  it("returns duplicate when either unique RFQ key is already claimed", async () => {
    const client = new QueueDynamoClient([
      new DynamoConditionalCheckFailed("duplicate"),
    ]);
    const store = new DynamoSyntheticSupplierStore(client, "stockguard-test", now);

    await expect(store.createRfq(rfq)).resolves.toBe("DUPLICATE");
  });

  it("does not return an expired RFQ from a routing lookup", async () => {
    const client = new QueueDynamoClient([{ item: { ...rfq } }]);
    const store = new DynamoSyntheticSupplierStore(
      client,
      "stockguard-test",
      () => new Date("2026-08-21T10:00:00Z"),
    );

    await expect(store.resolveRoutingCode("281001")).resolves.toBeNull();
    expect(client.commands[0]).toMatchObject({
      operation: "Get",
      key: { PK: "SYNTHETIC_ROUTING#281001" },
      consistentRead: true,
    });
  });

  it("uses optimistic dataset versioning for controlled profile changes", async () => {
    const client = new QueueDynamoClient();
    const store = new DynamoSyntheticSupplierStore(client, "stockguard-test", now);
    const profile = {
      ...syntheticSupplierProfiles.DE_SUPPLIER,
      state: "OUT_OF_STOCK" as const,
      datasetVersion: "synthetic-suppliers-2026-08-v2",
    };

    await expect(
      store.updateProfile({
        profile,
        expectedDatasetVersion: "synthetic-suppliers-2026-08-v1",
      }),
    ).resolves.toBe("UPDATED");

    expect(client.commands[0]).toMatchObject({
      operation: "Put",
      conditionExpression: "#datasetVersion = :expectedDatasetVersion",
      expressionAttributeValues: {
        ":expectedDatasetVersion": "synthetic-suppliers-2026-08-v1",
      },
      item: { state: "OUT_OF_STOCK", datasetVersion: profile.datasetVersion },
    });
  });
});
