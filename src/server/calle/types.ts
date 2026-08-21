import type { Currency } from "../../domain";

export type SupportedCallRegion = "DE" | "FR" | "PL" | "GB" | "US";
export type SupportedCallLocale = "de-DE" | "fr-FR" | "pl-PL" | "en-GB" | "en-US";

export type SupplierCallRequest = {
  workflowId: string;
  attemptNumber: number;
  supplierId: string;
  supplierName: string;
  phoneE164: string;
  region: SupportedCallRegion;
  locale: SupportedCallLocale;
  sku: string;
  requestedQuantity: number;
  requiredBy: string;
  consentVerified: boolean;
};

export type CallAuthorization = {
  workflowId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  maximumCalls: number;
  allowedSupplierIds: string[];
  allowedPhoneNumbers: string[];
};

export type SupplierCallStructuredResult = {
  supplierId: string;
  language: string;
  skuConfirmed: boolean;
  availableQuantity: number | null;
  unitPrice: number | null;
  currency: Currency | null;
  deliveryAt: string | null;
  offerValidUntil: string | null;
  commercialTermsChanged: boolean;
  optOutRequested: boolean;
  notes: string | null;
};

export type EvidenceField =
  | "skuConfirmed"
  | "availableQuantity"
  | "unitPrice"
  | "currency"
  | "deliveryAt"
  | "offerValidUntil"
  | "commercialTermsChanged";

export type FieldEvidence = {
  field: EvidenceField;
  source: "transcript" | "structured-result" | "operator";
  excerpt: string;
  verified: boolean;
};

export type StructuredResultValidation = {
  valid: boolean;
  issues: Array<{ field: string; message: string }>;
};

export type SupplierCallTask = {
  callId: string;
  status: "planned" | "queued" | "in_progress" | "completed" | "failed";
  taskCompleted: boolean;
  completionConfidence: number | null;
  structuredResult: SupplierCallStructuredResult | null;
  evidence: string[];
  fieldEvidence: Partial<Record<EvidenceField, FieldEvidence>>;
  schemaValidation: StructuredResultValidation;
  outcome:
    | "ANSWERED"
    | "NO_ANSWER"
    | "VOICEMAIL"
    | "TIMEOUT"
    | "FAILED"
    | "INCOMPLETE";
};

export interface SupplierCallingPort {
  startSupplierCall(
    request: SupplierCallRequest,
    authorization: CallAuthorization,
  ): Promise<SupplierCallTask>;

  getSupplierCall(callId: string): Promise<SupplierCallTask>;
}
