import {
  DynamoConditionalCheckFailed,
  type DynamoDocumentPort,
} from "../../aws/dynamoDocument";
import type {
  StoredVoiceGrant,
  VoiceGrantClaim,
  VoiceSessionStore,
} from "../voiceSessionStore";

/**
 * Durable single-use WebRTC grants.
 *
 * One item per procurement session, created with
 * `attribute_not_exists(PK)`. That single condition is the whole single-use
 * guarantee: two concurrent requests for the same session produce one contact
 * and one refusal, on one instance or on twenty.
 *
 * The item carries `expiresAtEpoch`, so DynamoDB TTL removes it after the grant
 * is long dead. Expiry is still checked in code — TTL deletion is best-effort
 * and can lag by hours, so it is a cleanup mechanism, never an access control.
 */
export class DynamoVoiceSessionStore implements VoiceSessionStore {
  constructor(
    private readonly client: DynamoDocumentPort,
    private readonly tableName: string,
    /** How long the row outlives the grant, for post-hoc inspection. */
    private readonly retentionSeconds = 24 * 60 * 60,
  ) {}

  private key(sessionId: string): Record<string, string> {
    return { PK: `VOICEGRANT#${sessionId}`, SK: "GRANT" };
  }

  async claimGrant(grant: StoredVoiceGrant): Promise<VoiceGrantClaim> {
    try {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...this.key(grant.sessionId),
          entityType: "VoiceSessionGrant",
          ...structuredClone(grant),
          expiresAtEpoch:
            Math.floor(Date.parse(grant.expiresAt) / 1000) + this.retentionSeconds,
        },
        conditionExpression: "attribute_not_exists(#pk)",
        expressionAttributeNames: { "#pk": "PK" },
      });
      return { kind: "CLAIMED" };
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
      const existing = await this.get(grant.sessionId);
      if (!existing) {
        /*
         * The condition failed but the row is gone: it expired between the two
         * calls. Report ALREADY_ISSUED rather than retrying the create — a
         * retry here is indistinguishable from starting a second billable
         * contact for the same session.
         */
        return {
          kind: "ALREADY_ISSUED",
          grant: { ...structuredClone(grant), consumedAt: grant.issuedAt },
        };
      }
      return { kind: "ALREADY_ISSUED", grant: existing };
    }
  }

  async get(sessionId: string): Promise<StoredVoiceGrant | null> {
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: this.key(sessionId),
      consistentRead: true,
    });
    if (!result.item) return null;
    const item = result.item;
    return {
      sessionId: String(item.sessionId),
      judgeId: String(item.judgeId),
      contactId: String(item.contactId),
      issuedAt: String(item.issuedAt),
      expiresAt: String(item.expiresAt),
      consumedAt: typeof item.consumedAt === "string" ? item.consumedAt : null,
    };
  }

  /**
   * Marks the grant used, conditional on it not already being used.
   *
   * A second consume is a no-op rather than an error: the caller's intent
   * (this grant must not be reusable) is already satisfied.
   */
  async markConsumed(sessionId: string, consumedAt: string): Promise<void> {
    try {
      await this.client.execute({
        operation: "Update",
        tableName: this.tableName,
        key: this.key(sessionId),
        updateExpression: "SET #consumedAt = :consumedAt",
        conditionExpression: "attribute_exists(#pk) AND #consumedAt = :unset",
        expressionAttributeNames: { "#pk": "PK", "#consumedAt": "consumedAt" },
        expressionAttributeValues: { ":consumedAt": consumedAt, ":unset": null },
      });
    } catch (error) {
      if (!(error instanceof DynamoConditionalCheckFailed)) throw error;
    }
  }
}
