import type {
  EvidenceField,
  StructuredResultValidation,
  SupplierCallStructuredResult,
} from "./types";

const currencies = new Set(["EUR", "PLN", "USD", "GBP"]);
const evidenceFields: EvidenceField[] = [
  "skuConfirmed",
  "availableQuantity",
  "unitPrice",
  "currency",
  "deliveryAt",
  "offerValidUntil",
  "commercialTermsChanged",
];

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateSupplierCallResult(
  value: unknown,
): StructuredResultValidation & {
  result: SupplierCallStructuredResult | null;
  evidenceExcerpts: Partial<Record<EvidenceField, string>>;
} {
  const issues: StructuredResultValidation["issues"] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ field: "$", message: "Structured result must be an object" }],
      result: null,
      evidenceExcerpts: {},
    };
  }

  const record = value as Record<string, unknown>;
  for (const field of [
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
    "fieldEvidence",
  ]) {
    if (!(field in record)) {
      issues.push({ field, message: "Required field is missing" });
    }
  }

  if (typeof record.supplierId !== "string" || record.supplierId.length === 0) {
    issues.push({ field: "supplierId", message: "Must be a non-empty string" });
  }
  if (typeof record.language !== "string" || record.language.length === 0) {
    issues.push({ field: "language", message: "Must be a non-empty string" });
  }
  if (typeof record.skuConfirmed !== "boolean") {
    issues.push({ field: "skuConfirmed", message: "Must be boolean" });
  }
  if (
    typeof record.availableQuantity !== "number" ||
    !Number.isInteger(record.availableQuantity) ||
    record.availableQuantity < 0
  ) {
    issues.push({
      field: "availableQuantity",
      message: "Must be a non-negative integer",
    });
  }
  if (
    typeof record.unitPrice !== "number" ||
    !Number.isFinite(record.unitPrice) ||
    record.unitPrice < 0
  ) {
    issues.push({
      field: "unitPrice",
      message: "Must be a non-negative finite number",
    });
  }
  if (typeof record.currency !== "string" || !currencies.has(record.currency)) {
    issues.push({ field: "currency", message: "Must be an approved currency enum" });
  }
  if (!isDateTime(record.deliveryAt)) {
    issues.push({ field: "deliveryAt", message: "Must be a valid ISO date-time" });
  }
  if (!isDateTime(record.offerValidUntil)) {
    issues.push({
      field: "offerValidUntil",
      message: "Must be a valid ISO date-time",
    });
  }
  if (typeof record.commercialTermsChanged !== "boolean") {
    issues.push({ field: "commercialTermsChanged", message: "Must be boolean" });
  }
  if (typeof record.optOutRequested !== "boolean") {
    issues.push({ field: "optOutRequested", message: "Must be boolean" });
  }
  if (typeof record.notes !== "string") {
    issues.push({ field: "notes", message: "Must be a string" });
  }

  const evidenceExcerpts: Partial<Record<EvidenceField, string>> = {};
  const rawEvidence = record.fieldEvidence;
  if (
    typeof rawEvidence !== "object" ||
    rawEvidence === null ||
    Array.isArray(rawEvidence)
  ) {
    issues.push({ field: "fieldEvidence", message: "Must be an evidence object" });
  } else {
    const evidenceRecord = rawEvidence as Record<string, unknown>;
    for (const field of evidenceFields) {
      const excerpt = evidenceRecord[field];
      if (typeof excerpt !== "string" || excerpt.trim().length === 0) {
        issues.push({
          field: `fieldEvidence.${field}`,
          message: "Must contain a non-empty evidence excerpt",
        });
      } else {
        evidenceExcerpts[field] = excerpt.trim();
      }
    }
  }

  const result: SupplierCallStructuredResult | null =
    issues.length === 0
      ? {
          supplierId: record.supplierId as string,
          language: record.language as string,
          skuConfirmed: record.skuConfirmed as boolean,
          availableQuantity: record.availableQuantity as number,
          unitPrice: record.unitPrice as number,
          currency: record.currency as SupplierCallStructuredResult["currency"],
          deliveryAt: record.deliveryAt as string,
          offerValidUntil: record.offerValidUntil as string,
          commercialTermsChanged: record.commercialTermsChanged as boolean,
          optOutRequested: record.optOutRequested as boolean,
          notes: record.notes as string,
        }
      : null;

  return {
    valid: issues.length === 0,
    issues,
    result,
    evidenceExcerpts,
  };
}
