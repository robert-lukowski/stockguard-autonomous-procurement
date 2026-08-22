import type { Currency } from "../../domain";

export type SupplierProfileId =
  | "DE_SUPPLIER"
  | "FR_SUPPLIER"
  | "PL_SUPPLIER"
  | "EN_SUPPLIER";

/*
 * Two different locale vocabularies meet here, and they must not be mixed.
 *
 *   Lex V2 locale id  -> underscore form, e.g. "en_US". AWS identifier.
 *   CALL-E spoken locale -> BCP 47 hyphen form, e.g. "en-US".
 *
 * Everything inside the simulator speaks Lex ids. The conversion happens once,
 * explicitly, at the boundary in `callELocaleFor`.
 *
 * The English supplier uses en_US rather than en_GB: en_GB is already the
 * router locale, and the Connect/Lex runtime for the first qualification is
 * configured for US English against the existing +1 number.
 */
export type LexSupplierLocale = "de_DE" | "fr_FR" | "pl_PL" | "en_US";
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
  routingCode: string;
  profileId: SupplierProfileId;
  datasetVersion: string;
  sku: string;
  requestedQuantity: number;
  requiredBy: string;
  expiresAt: string;
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
  resolveRoutingCode(routingCode: string): Promise<SyntheticRfq | null>;
}

export type SyntheticProfileUpdate = {
  profile: SyntheticSupplierProfile;
  expectedDatasetVersion: string;
};

export interface SyntheticSupplierAdminPort {
  createRfq(rfq: SyntheticRfq): Promise<"CREATED" | "DUPLICATE">;
  updateProfile(update: SyntheticProfileUpdate): Promise<"UPDATED" | "VERSION_CONFLICT">;
}

export type SupplierSimulatorIntent =
  | "GetSupplierQuote"
  | "CheckRemainingQuantity"
  | "ConfirmOfferValidity"
  | "ConfirmCommercialTerms"
  | "EndConversation";

/**
 * Maps a Lex V2 locale id onto the CALL-E spoken locale.
 *
 * The only place the two vocabularies are allowed to meet.
 */
export function callELocaleFor(
  locale: LexSupplierLocale,
): "de-DE" | "fr-FR" | "pl-PL" | "en-US" {
  switch (locale) {
    case "de_DE":
      return "de-DE";
    case "fr_FR":
      return "fr-FR";
    case "pl_PL":
      return "pl-PL";
    case "en_US":
      return "en-US";
  }
}

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
