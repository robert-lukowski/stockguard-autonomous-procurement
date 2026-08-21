import type { Currency } from "../../domain";

export type SupplierProfileId =
  | "DE_SUPPLIER"
  | "FR_SUPPLIER"
  | "PL_SUPPLIER";

export type LexSupplierLocale = "de_DE" | "fr_FR" | "pl_PL";
export type LexSimulatorLocale = LexSupplierLocale | "en_GB";

export type SyntheticSupplierState =
  | "AVAILABLE"
  | "PARTIAL_STOCK"
  | "OUT_OF_STOCK"
  | "LATE_DELIVERY"
  | "PRICE_CHANGED"
  | "OFFER_EXPIRED"
  | "CHANGED_PAYMENT_TERMS";

export type SyntheticSupplierProfile = {
  profileId: SupplierProfileId;
  supplierId: string;
  supplierName: string;
  locale: LexSupplierLocale;
  currency: Currency;
  baseUnitPrice: number;
  state: SyntheticSupplierState;
  datasetVersion: string;
};

export type SyntheticRfq = {
  runId: string;
  rfqId: string;
  profileId: SupplierProfileId;
  sku: string;
  requestedQuantity: number;
  requiredBy: string;
};

export type SyntheticSupplierQuote = {
  runId: string;
  rfqId: string;
  profileId: SupplierProfileId;
  supplierId: string;
  supplierName: string;
  locale: LexSupplierLocale;
  state: SyntheticSupplierState;
  sku: string;
  skuConfirmed: true;
  requestedQuantity: number;
  availableQuantity: number;
  remainingQuantity: number;
  unitPrice: number;
  currency: Currency;
  deliveryAt: string;
  remainingDeliveryAt: string | null;
  offerValidUntil: string;
  commercialTermsChanged: boolean;
  commercialTermsSummary: string;
  datasetVersion: string;
  deterministic: true;
};

export interface SyntheticSupplierStore {
  getProfile(profileId: SupplierProfileId): Promise<SyntheticSupplierProfile | null>;
  resolveRfq(rfqId: string): Promise<SyntheticRfq | null>;
}

export type SupplierSimulatorIntent =
  | "GetSupplierQuote"
  | "CheckRemainingQuantity"
  | "ConfirmOfferValidity"
  | "ConfirmCommercialTerms"
  | "EndConversation";

export type SupplierSimulatorRequest = {
  intent: SupplierSimulatorIntent;
  rfqId: string;
  profileId?: SupplierProfileId;
};

export type SupplierSimulatorResponse = {
  intent: SupplierSimulatorIntent;
  quote: SyntheticSupplierQuote;
  message: string;
  continueConversation: boolean;
};
