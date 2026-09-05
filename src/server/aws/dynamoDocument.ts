export type DynamoCommand =
  | {
      operation: "Get";
      tableName: string;
      key: Record<string, unknown>;
      consistentRead: boolean;
    }
  | {
      operation: "Put";
      tableName: string;
      item: Record<string, unknown>;
      conditionExpression?: string;
      expressionAttributeNames?: Record<string, string>;
      expressionAttributeValues?: Record<string, unknown>;
    }
  | {
      operation: "Update";
      tableName: string;
      key: Record<string, unknown>;
      updateExpression: string;
      conditionExpression?: string;
      expressionAttributeNames: Record<string, string>;
      expressionAttributeValues: Record<string, unknown>;
    }
  | {
      /**
       * Reads every item under one partition key.
       *
       * Added for the procurement store, whose session is spread across several
       * items so that the security-critical writes (single-use confirmation,
       * run completion) can each be their own conditional write instead of a
       * read-modify-write of one large item.
       */
      operation: "Query";
      tableName: string;
      keyConditionExpression: string;
      expressionAttributeNames: Record<string, string>;
      expressionAttributeValues: Record<string, unknown>;
      consistentRead: boolean;
    }
  | {
      operation: "TransactWrite";
      items: Array<{
        operation: "Put";
        tableName: string;
        item: Record<string, unknown>;
        conditionExpression?: string;
        expressionAttributeNames?: Record<string, string>;
        expressionAttributeValues?: Record<string, unknown>;
      }>;
    };

export type DynamoCommandResult = {
  item?: Record<string, unknown>;
  /** Populated by Query. Ordered by sort key, ascending. */
  items?: Record<string, unknown>[];
};

/**
 * SDK-independent command boundary. A deployed composition root may translate
 * these commands into AWS SDK v3 DocumentClient calls. Tests never need AWS.
 */
export interface DynamoDocumentPort {
  execute(command: DynamoCommand): Promise<DynamoCommandResult>;
}

export class DynamoConditionalCheckFailed extends Error {}
