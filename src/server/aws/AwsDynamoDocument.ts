import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  DynamoConditionalCheckFailed,
  type DynamoCommand,
  type DynamoCommandResult,
  type DynamoDocumentPort,
} from "./dynamoDocument";

/**
 * The AWS SDK v3 composition root for `DynamoDocumentPort`.
 *
 * This is the only file in the repository that imports a DynamoDB client. Every
 * store stays SDK-free and testable, and the translation from our four commands
 * to the SDK lives here alone.
 *
 * The one behaviour the stores actually depend on is the conditional-check
 * failure. `ConditionalCheckFailedException` is how DynamoDB reports "someone
 * else won the race", and every atomic guarantee in the procurement and voice
 * stores is built on catching it — so it is translated into our own error type
 * rather than leaking an SDK class into the domain.
 */

function isConditionalCheckFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "ConditionalCheckFailedException") return true;

  /*
   * A transaction reports the same condition failure under a different name,
   * with the per-item reasons in CancellationReasons. Treating it as anything
   * other than a conditional failure would turn a lost race into a 500.
   */
  if (name !== "TransactionCanceledException") return false;
  const reasons =
    "CancellationReasons" in error && Array.isArray(error.CancellationReasons)
      ? error.CancellationReasons
      : [];
  return reasons.some(
    (reason) =>
      typeof reason === "object" &&
      reason !== null &&
      "Code" in reason &&
      reason.Code === "ConditionalCheckFailed",
  );
}

export type AwsDynamoDocumentConfig = {
  region?: string;
  /** Injected in tests; production builds the client from the Lambda role. */
  client?: DynamoDBDocumentClient;
};

export class AwsDynamoDocument implements DynamoDocumentPort {
  private readonly client: DynamoDBDocumentClient;

  constructor(config: AwsDynamoDocumentConfig = {}) {
    this.client =
      config.client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient(config.region ? { region: config.region } : {}),
        {
          marshallOptions: {
            // Our items carry explicit nulls (outcome, completedAt, consumedAt)
            // and the conditional writes compare against them, so they must be
            // stored rather than stripped.
            removeUndefinedValues: true,
            convertClassInstanceToMap: false,
          },
        },
      );
  }

  async execute(command: DynamoCommand): Promise<DynamoCommandResult> {
    try {
      switch (command.operation) {
        case "Get": {
          const result = await this.client.send(
            new GetCommand({
              TableName: command.tableName,
              Key: command.key,
              ConsistentRead: command.consistentRead,
            }),
          );
          return result.Item ? { item: result.Item } : {};
        }

        case "Put": {
          await this.client.send(
            new PutCommand({
              TableName: command.tableName,
              Item: command.item,
              ConditionExpression: command.conditionExpression,
              ExpressionAttributeNames: command.expressionAttributeNames,
              ExpressionAttributeValues: command.expressionAttributeValues,
            }),
          );
          return {};
        }

        case "Update": {
          await this.client.send(
            new UpdateCommand({
              TableName: command.tableName,
              Key: command.key,
              UpdateExpression: command.updateExpression,
              ConditionExpression: command.conditionExpression,
              ExpressionAttributeNames: command.expressionAttributeNames,
              ExpressionAttributeValues: command.expressionAttributeValues,
            }),
          );
          return {};
        }

        case "Query": {
          /*
           * Paginated deliberately. A long procurement session accumulates one
           * item per audit event, and a single Query page would silently
           * truncate the audit trail — which is the one thing that must never
           * be quietly incomplete.
           */
          const items: Record<string, unknown>[] = [];
          let startKey: Record<string, unknown> | undefined;
          do {
            const page = await this.client.send(
              new QueryCommand({
                TableName: command.tableName,
                KeyConditionExpression: command.keyConditionExpression,
                ExpressionAttributeNames: command.expressionAttributeNames,
                ExpressionAttributeValues: command.expressionAttributeValues,
                ConsistentRead: command.consistentRead,
                ExclusiveStartKey: startKey,
              }),
            );
            items.push(...(page.Items ?? []));
            startKey = page.LastEvaluatedKey;
          } while (startKey);
          return { items };
        }

        case "TransactWrite": {
          await this.client.send(
            new TransactWriteCommand({
              TransactItems: command.items.map((item) => ({
                Put: {
                  TableName: item.tableName,
                  Item: item.item,
                  ConditionExpression: item.conditionExpression,
                  ExpressionAttributeNames: item.expressionAttributeNames,
                  ExpressionAttributeValues: item.expressionAttributeValues,
                },
              })),
            }),
          );
          return {};
        }
      }
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new DynamoConditionalCheckFailed("The conditional request failed");
      }
      throw error;
    }
  }
}
