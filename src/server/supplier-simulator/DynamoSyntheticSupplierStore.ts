import {
  DynamoConditionalCheckFailed,
  type DynamoDocumentPort,
} from "../aws/dynamoDocument";
import type {
  LexSupplierLocale,
  SupplierProfileId,
  SyntheticProfileUpdate,
  SyntheticRfq,
  SyntheticSupplierAdminPort,
  SyntheticSupplierProfile,
  SyntheticSupplierState,
  SyntheticSupplierStore,
} from "./types";

const profileIds = new Set<SupplierProfileId>([
  "DE_SUPPLIER",
  "FR_SUPPLIER",
  "PL_SUPPLIER",
]);
const locales = new Set<LexSupplierLocale>(["de_DE", "fr_FR", "pl_PL"]);
const states = new Set<SyntheticSupplierState>([
  "AVAILABLE",
  "PARTIAL_STOCK",
  "OUT_OF_STOCK",
  "LATE_DELIVERY",
  "PRICE_CHANGED",
  "OFFER_EXPIRED",
  "CHANGED_PAYMENT_TERMS",
]);
const currencies = new Set(["EUR", "PLN", "USD", "GBP"] as const);

function stringField(item: Record<string, unknown>, field: string): string {
  const value = item[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid synthetic data field: ${field}`);
  }
  return value;
}

function profileFrom(item: Record<string, unknown>): SyntheticSupplierProfile {
  const profileId = stringField(item, "profileId") as SupplierProfileId;
  const locale = stringField(item, "locale") as LexSupplierLocale;
  const state = stringField(item, "state") as SyntheticSupplierState;
  const currency = stringField(item, "currency") as SyntheticSupplierProfile["currency"];
  if (
    !profileIds.has(profileId) ||
    !locales.has(locale) ||
    !states.has(state) ||
    !currencies.has(currency)
  ) {
    throw new Error("Invalid synthetic supplier profile enum value");
  }
  const baseUnitPrice = item.baseUnitPrice;
  if (
    typeof baseUnitPrice !== "number" ||
    !Number.isFinite(baseUnitPrice) ||
    baseUnitPrice < 0
  ) {
    throw new Error("Invalid synthetic supplier baseUnitPrice");
  }
  return {
    profileId,
    supplierId: stringField(item, "supplierId"),
    supplierName: stringField(item, "supplierName"),
    locale,
    currency,
    baseUnitPrice,
    state,
    datasetVersion: stringField(item, "datasetVersion"),
  };
}

function rfqFrom(item: Record<string, unknown>): SyntheticRfq {
  const profileId = stringField(item, "profileId") as SupplierProfileId;
  const requestedQuantity = item.requestedQuantity;
  if (!profileIds.has(profileId)) throw new Error("Invalid synthetic RFQ profile");
  if (
    typeof requestedQuantity !== "number" ||
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity <= 0
  ) {
    throw new Error("Invalid synthetic RFQ quantity");
  }
  const rfq: SyntheticRfq = {
    runId: stringField(item, "runId"),
    rfqId: stringField(item, "rfqId"),
    routingCode: stringField(item, "routingCode"),
    profileId,
    datasetVersion: stringField(item, "datasetVersion"),
    sku: stringField(item, "sku"),
    requestedQuantity,
    requiredBy: stringField(item, "requiredBy"),
    expiresAt: stringField(item, "expiresAt"),
  };
  if (
    !/^\d{6}$/.test(rfq.routingCode) ||
    !Number.isFinite(Date.parse(rfq.requiredBy)) ||
    !Number.isFinite(Date.parse(rfq.expiresAt))
  ) {
    throw new Error("Invalid synthetic RFQ routing code or timestamp");
  }
  return rfq;
}

function profileKey(profileId: SupplierProfileId) {
  return { PK: `SYNTHETIC_PROFILE#${profileId}`, SK: "METADATA" };
}

function rfqKey(rfqId: string) {
  return { PK: `SYNTHETIC_RFQ#${rfqId}`, SK: "METADATA" };
}

function routingKey(routingCode: string) {
  return { PK: `SYNTHETIC_ROUTING#${routingCode}`, SK: "METADATA" };
}

/**
 * Persistence contract only. It does not create a table or send an AWS request
 * unless a deployed composition root supplies a real DynamoDocumentPort.
 */
export class DynamoSyntheticSupplierStore
  implements SyntheticSupplierStore, SyntheticSupplierAdminPort
{
  constructor(
    private readonly client: DynamoDocumentPort,
    private readonly tableName: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getProfile(
    profileId: SupplierProfileId,
  ): Promise<SyntheticSupplierProfile | null> {
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: profileKey(profileId),
      consistentRead: true,
    });
    return result.item ? profileFrom(result.item) : null;
  }

  async resolveRfq(rfqId: string): Promise<SyntheticRfq | null> {
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: rfqKey(rfqId),
      consistentRead: true,
    });
    return this.activeRfq(result.item);
  }

  async resolveRoutingCode(routingCode: string): Promise<SyntheticRfq | null> {
    if (!/^\d{6}$/.test(routingCode)) return null;
    const result = await this.client.execute({
      operation: "Get",
      tableName: this.tableName,
      key: routingKey(routingCode),
      consistentRead: true,
    });
    return this.activeRfq(result.item);
  }

  private activeRfq(item?: Record<string, unknown>): SyntheticRfq | null {
    if (!item) return null;
    const rfq = rfqFrom(item);
    return Date.parse(rfq.expiresAt) > this.clock().getTime() ? rfq : null;
  }

  async createRfq(rfq: SyntheticRfq): Promise<"CREATED" | "DUPLICATE"> {
    const validated = rfqFrom(rfq as unknown as Record<string, unknown>);
    if (Date.parse(validated.expiresAt) <= this.clock().getTime()) {
      throw new Error("Cannot persist an expired synthetic RFQ");
    }
    const expiresAtEpoch = Math.floor(Date.parse(validated.expiresAt) / 1000);
    const commonItem = {
      entityType: "SyntheticRfq",
      ...structuredClone(validated),
      expiresAtEpoch,
    };
    try {
      await this.client.execute({
        operation: "TransactWrite",
        items: [rfqKey(validated.rfqId), routingKey(validated.routingCode)].map((key) => ({
          operation: "Put" as const,
          tableName: this.tableName,
          item: { ...key, ...commonItem },
          conditionExpression: "attribute_not_exists(#pk)",
          expressionAttributeNames: { "#pk": "PK" },
        })),
      });
      return "CREATED";
    } catch (error) {
      if (error instanceof DynamoConditionalCheckFailed) return "DUPLICATE";
      throw error;
    }
  }

  async updateProfile(
    update: SyntheticProfileUpdate,
  ): Promise<"UPDATED" | "VERSION_CONFLICT"> {
    const profile = profileFrom(
      update.profile as unknown as Record<string, unknown>,
    );
    try {
      await this.client.execute({
        operation: "Put",
        tableName: this.tableName,
        item: {
          ...profileKey(profile.profileId),
          entityType: "SyntheticSupplierProfile",
          ...structuredClone(profile),
        },
        conditionExpression: "#datasetVersion = :expectedDatasetVersion",
        expressionAttributeNames: { "#datasetVersion": "datasetVersion" },
        expressionAttributeValues: {
          ":expectedDatasetVersion": update.expectedDatasetVersion,
        },
      });
      return "UPDATED";
    } catch (error) {
      if (error instanceof DynamoConditionalCheckFailed) {
        return "VERSION_CONFLICT";
      }
      throw error;
    }
  }
}
