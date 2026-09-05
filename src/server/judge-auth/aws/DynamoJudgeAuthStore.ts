import {
  DynamoConditionalCheckFailed,
  type DynamoDocumentPort,
} from "../../aws/dynamoDocument";
import type { JudgeAuthSession, JudgeAuthStore } from "../types";

/**
 * Durable judge sessions, keyed by token hash.
 *
 * Shares the procurement table: same lifecycle, same TTL attribute, same blast
 * radius. A separate table would mean a second thing to deploy for no
 * isolation gain, since the voice-session Lambda already reads both.
 *
 *   PK = JUDGEAUTH#<sha256(token)>
 *   SK = SESSION
 *
 * Keying on the hash rather than on a session id makes authorizing a single
 * point read on the hot path of every API call. The plaintext token never
 * reaches DynamoDB.
 */
export class DynamoJudgeAuthStore implements JudgeAuthStore {
  constructor(
    private readonly client: DynamoDocumentPort,
    private readonly tableName: string,
  ) {}

  private key(tokenHash: string): Record<string, string> {
    return { PK: `JUDGEAUTH#${tokenHash}`, SK: "SESSION" };
  }

  async create(session: JudgeAuthSession): Promise<"CREATED" | "DUPLICATE"> {
    try {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...this.key(session.tokenHash),
          entityType: "JudgeAuthSession",
          ...structuredClone(session),
          expiresAtEpoch: Math.floor(Date.parse(session.expiresAt) / 1000),
        },
        conditionExpression: "attribute_not_exists(#pk)",
        expressionAttributeNames: { "#pk": "PK" },
      });
      return "CREATED";
    } catch (error) {
      if (error instanceof DynamoConditionalCheckFailed) return "DUPLICATE";
      throw error;
    }
  }

  async findByTokenHash(tokenHash: string): Promise<JudgeAuthSession | null> {
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: this.key(tokenHash),
      consistentRead: true,
    });
    if (!result.item) return null;

    const item = result.item;
    return {
      judgeId: String(item.judgeId),
      tokenHash: String(item.tokenHash),
      issuedAt: String(item.issuedAt),
      expiresAt: String(item.expiresAt),
      status: item.status === "REVOKED" ? "REVOKED" : "ACTIVE",
    };
  }

  /**
   * Revoking a session that no longer exists is a no-op.
   *
   * TTL may already have removed it, and the caller's intent — this token must
   * not work — is satisfied either way.
   */
  async revoke(tokenHash: string): Promise<void> {
    try {
      await this.client.execute({
        operation: "Update",
        tableName: this.tableName,
        key: this.key(tokenHash),
        updateExpression: "SET #status = :revoked",
        conditionExpression: "attribute_exists(#pk)",
        expressionAttributeNames: { "#pk": "PK", "#status": "status" },
        expressionAttributeValues: { ":revoked": "REVOKED" },
      });
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
    }
  }
}
