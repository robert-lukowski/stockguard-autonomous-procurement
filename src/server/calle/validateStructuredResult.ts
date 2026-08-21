import type {
  StructuredResultValidation,
  SupplierCallStructuredResult,
} from "./types";

const currencies = new Set(["EUR", "PLN", "USD", "GBP"]);

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateSupplierCallResult(
  value: unknown,
): StructuredResultValidation & { result: SupplierCallStructuredResult | null } {
  const issues: StructuredResultValidation["issues"] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ field: "$", message: "Structured result must be an object" }],
      result: null,
    };
  }

  const record = value as Record<string, unknown>;
  const required = [
    "supplierId",
    "language",
    "skuConfirmed",
    "availableQuantity",
    "unitPrice",
    "currency",
    "deliveryAt",
    "offerValidUntil",
    "commercialTermsChanged",
    "optOutRequested",
    "notes",
  ];
  for (const field of required) {
    if (!(field in record)) issues.push({ field, message: "Required field is missing" });
  }

  if (typeof record.supplierId !== "string" || record.supplierId.length === 0) issues.push({ field: "supplierId", message: "Must be a non-empty string" });
  if (typeof record.language !== "string" || record.language.length === 0) issues.push({ field: "language", message: "Must be a non-empty string" });
  if (typeof record.skuConfirmed !== "boolean") issues.push({ field: "skuConfirmed", message: "Must be boolean" });
  if (record.availableQuantity !== null && (typeof record.availableQuantity !== "number" || !Number.isInteger(record.availableQuantity) || record.availableQuantity < 0)) issues.push({ field: "availableQuantity", message: "Must be a non-negative integer or null" });
  if (record.unitPrice !== null && (typeof record.unitPrice !== "number" || !Number.isFinite(record.unitPrice) || record.unitPrice < 0)) issues.push({ field: "unitPrice", message: "Must be a non-negative finite number or null" });
  if (record.currency !== null && (typeof record.currency !== "string" || !currencies.has(record.currency))) issues.push({ field: "currency", message: "Must be an approved currency enum or null" });
  if (record.deliveryAt !== null && !isDateTime(record.deliveryAt)) issues.push({ field: "deliveryAt", message: "Must be a valid ISO date-time or null" });
  if (record.offerValidUntil !== null && !isDateTime(record.offerValidUntil)) issues.push({ field: "offerValidUntil", message: "Must be a valid ISO date-time or null" });
  if (typeof record.commercialTermsChanged !== "boolean") issues.push({ field: "commercialTermsChanged", message: "Must be boolean" });
  if (typeof record.optOutRequested !== "boolean") issues.push({ field: "optOutRequested", message: "Must be boolean" });
  if (record.notes !== null && typeof record.notes !== "string") issues.push({ field: "notes", message: "Must be a string or null" });

  return {
    valid: issues.length === 0,
    issues,
    result: issues.length === 0 ? (record as SupplierCallStructuredResult) : null,
  };
}
