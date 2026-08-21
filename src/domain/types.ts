export type Currency = "EUR" | "PLN" | "USD" | "GBP";

export type InventoryPosition = {
  sku: string;
  onHand: number;
  confirmedDemand: number;
  inboundConfirmed: number;
  safetyStock: number;
  stockoutAt: string;
};

export type ShortageForecast = {
  sku: string;
  requiredQuantity: number;
  projectedAvailable: number;
  stockoutAt: string;
  shortageDetected: boolean;
};

export type SupplierOffer = {
  offerId: string;
  supplierId: string;
  supplierName: string;
  approvedSupplier: boolean;
  consentVerified: boolean;
  language: string;
  sku: string;
  exactSkuConfirmed: boolean;
  availableQuantity: number;
  unitPrice: number;
  currency: Currency;
  deliveryAt: string;
  offerValidUntil: string | null;
  commercialTermsChanged: boolean;
  evidenceComplete: boolean;
  evidenceStatus: Record<
    | "skuConfirmed"
    | "availableQuantity"
    | "unitPrice"
    | "currency"
    | "deliveryAt"
    | "offerValidUntil"
    | "commercialTermsChanged",
    "VERIFIED" | "UNVERIFIED" | "NOT_PROVIDED"
  >;
  evidenceByField: Partial<
    Record<
      | "skuConfirmed"
      | "availableQuantity"
      | "unitPrice"
      | "currency"
      | "deliveryAt"
      | "offerValidUntil"
      | "commercialTermsChanged",
      { source: string; excerpt: string; verified: boolean }
    >
  >;
  completionConfidence: number;
  attemptCount: number;
};

export type ProcurementPolicy = {
  version: string;
  autonomousOrderLimitEur: number;
  unitPriceCeilingEur: number;
  minimumConfidence: number;
  maximumAttempts: number;
  approvedCurrencies: Currency[];
};

export type ExchangeRatesToEur = Record<Currency, number>;

export type NormalizedOffer = SupplierOffer & {
  unitPriceEur: number;
  totalPriceEur: number;
};

export type PolicyCheck = {
  id: string;
  status: "PASS" | "FAIL" | "REQUIRES_HUMAN";
  passed: boolean;
  evidence: string;
  inputs: Record<string, string | number | boolean | null>;
};

export type ValidationResult = {
  decision: "PASS" | "BLOCK" | "REQUIRES_HUMAN";
  checks: PolicyCheck[];
  policyVersion: string;
  failedCheckIds: string[];
  humanReviewCheckIds: string[];
};

export type ProcurementDecision = {
  status: "ORDER_APPROVED" | "HUMAN_EXCEPTION_REQUIRED";
  selectedOffer: NormalizedOffer | null;
  validation: ValidationResult | null;
  rejectedOffers: Array<{
    offer: NormalizedOffer;
    validation: ValidationResult;
  }>;
  reason: string;
};
