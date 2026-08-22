import type { MockSupplierResult } from "../calle";
import type {
  LexSupplierLocale,
  SupplierSimulatorRequest,
  SupplierSimulatorResponse,
  SyntheticRfq,
  SyntheticSupplierProfile,
  SyntheticSupplierQuote,
  SyntheticSupplierStore,
} from "./types";

function addDays(value: string, days: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Synthetic RFQ requiredBy is invalid");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function quoteFor(
  profile: SyntheticSupplierProfile,
  rfq: SyntheticRfq,
): SyntheticSupplierQuote {
  let availableQuantity = rfq.requestedQuantity;
  let unitPrice = profile.baseUnitPrice;
  let deliveryAt = addDays(rfq.requiredBy, -1);
  let remainingDeliveryAt: string | null = null;
  let offerValidUntil = addDays(rfq.requiredBy, -6);
  let commercialTermsChanged = false;
  let commercialTermsSummary = "Standard approved commercial terms remain unchanged.";

  switch (profile.state) {
    case "AVAILABLE":
      break;
    case "PARTIAL_STOCK":
      availableQuantity = Math.ceil(rfq.requestedQuantity * 0.7);
      remainingDeliveryAt = addDays(rfq.requiredBy, 3);
      break;
    case "OUT_OF_STOCK":
      availableQuantity = 0;
      remainingDeliveryAt = addDays(rfq.requiredBy, 14);
      break;
    case "LATE_DELIVERY":
      availableQuantity = Math.ceil(rfq.requestedQuantity * 1.2);
      deliveryAt = addDays(rfq.requiredBy, 8);
      break;
    case "PRICE_CHANGED":
      unitPrice = Math.round(profile.baseUnitPrice * 1.6 * 100) / 100;
      break;
    case "OFFER_EXPIRED":
      offerValidUntil = addDays(rfq.requiredBy, -10);
      break;
    case "CHANGED_PAYMENT_TERMS":
      commercialTermsChanged = true;
      commercialTermsSummary = "Payment terms changed from net 30 to advance payment.";
      break;
  }

  return {
    runId: rfq.runId,
    rfqId: rfq.rfqId,
    profileId: profile.profileId,
    supplierId: profile.supplierId,
    supplierName: profile.supplierName,
    locale: profile.locale,
    state: profile.state,
    sku: rfq.sku,
    skuConfirmed: true,
    requestedQuantity: rfq.requestedQuantity,
    availableQuantity,
    remainingQuantity: Math.max(0, rfq.requestedQuantity - availableQuantity),
    unitPrice,
    currency: profile.currency,
    deliveryAt,
    remainingDeliveryAt,
    offerValidUntil,
    commercialTermsChanged,
    commercialTermsSummary,
    datasetVersion: profile.datasetVersion,
    deterministic: true,
  };
}

function localizedMessage(
  locale: LexSupplierLocale,
  intent: SupplierSimulatorRequest["intent"],
  quote: SyntheticSupplierQuote,
): string {
  const values = {
    quantity: quote.availableQuantity,
    requested: quote.requestedQuantity,
    remaining: quote.remainingQuantity,
    price: quote.unitPrice.toFixed(2),
    currency: quote.currency,
    delivery: quote.deliveryAt.slice(0, 10),
    remainderDelivery: quote.remainingDeliveryAt?.slice(0, 10) ?? "not available",
    validUntil: quote.offerValidUntil.slice(0, 10),
  };

  const messages: Record<LexSupplierLocale, Record<typeof intent, string>> = {
    de_DE: {
      GetSupplierQuote: `Für RFQ ${quote.rfqId} sind ${values.quantity} von ${values.requested} Stück zu ${values.price} ${values.currency} pro Stück verfügbar. Lieferung: ${values.delivery}.`,
      CheckRemainingQuantity: `Die restlichen ${values.remaining} Stück können am ${values.remainderDelivery} geliefert werden.`,
      ConfirmOfferValidity: `Das Angebot ist bis ${values.validUntil} gültig.`,
      ConfirmCommercialTerms: quote.commercialTermsChanged
        ? "Die Zahlungsbedingungen wurden von 30 Tagen netto auf Vorauszahlung geändert."
        : "Die genehmigten Standardbedingungen bleiben unverändert.",
      EndConversation: "Die synthetische Angebotsauskunft ist abgeschlossen.",
    },
    fr_FR: {
      GetSupplierQuote: `Pour la demande ${quote.rfqId}, ${values.quantity} unités sur ${values.requested} sont disponibles à ${values.price} ${values.currency} par unité. Livraison le ${values.delivery}.`,
      CheckRemainingQuantity: `Les ${values.remaining} unités restantes peuvent être livrées le ${values.remainderDelivery}.`,
      ConfirmOfferValidity: `L'offre est valable jusqu'au ${values.validUntil}.`,
      ConfirmCommercialTerms: quote.commercialTermsChanged
        ? "Les conditions de paiement passent de 30 jours nets à un paiement anticipé."
        : "Les conditions commerciales standard approuvées restent inchangées.",
      EndConversation: "La réponse synthétique à la demande est terminée.",
    },
    en_US: {
      GetSupplierQuote: `For request ${'${quote.rfqId}'}, ${'${values.quantity}'} of ${'${values.requested}'} units are available at ${'${values.price}'} ${'${values.currency}'} per unit. Delivery on ${'${values.delivery}'}.`,
      CheckRemainingQuantity: `The remaining ${'${values.remaining}'} units can be delivered on ${'${values.remainderDelivery}'}.`,
      ConfirmOfferValidity: `The quote is valid until ${'${values.validUntil}'}.`,
      ConfirmCommercialTerms: quote.commercialTermsChanged
        ? "Payment terms have changed from net 30 days to advance payment."
        : "The approved standard commercial terms remain unchanged.",
      EndConversation: "That completes the synthetic quote response.",
    },
    pl_PL: {
      GetSupplierQuote: `Dla zapytania ${quote.rfqId} dostępnych jest ${values.quantity} z ${values.requested} sztuk po ${values.price} ${values.currency} za sztukę. Dostawa: ${values.delivery}.`,
      CheckRemainingQuantity: `Pozostałe ${values.remaining} sztuk może zostać dostarczone ${values.remainderDelivery}.`,
      ConfirmOfferValidity: `Oferta jest ważna do ${values.validUntil}.`,
      ConfirmCommercialTerms: quote.commercialTermsChanged
        ? "Warunki płatności zmieniono z 30 dni na płatność z góry."
        : "Standardowe zatwierdzone warunki handlowe pozostają bez zmian.",
      EndConversation: "Syntetyczna odpowiedź ofertowa została zakończona.",
    },
  };

  return messages[locale][intent];
}

export class SupplierSimulatorService {
  constructor(
    private readonly store: SyntheticSupplierStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async validateContext(
    rfq: SyntheticRfq | null,
    requestedProfileId?: SyntheticRfq["profileId"],
  ): Promise<{ rfq: SyntheticRfq; profile: SyntheticSupplierProfile }> {
    if (!rfq) throw new Error("Unknown synthetic RFQ");
    if (
      rfq.runId.length === 0 ||
      rfq.rfqId.length === 0 ||
      !/^\d{6}$/.test(rfq.routingCode) ||
      rfq.datasetVersion.length === 0 ||
      rfq.sku.length === 0 ||
      !Number.isInteger(rfq.requestedQuantity) ||
      rfq.requestedQuantity <= 0 ||
      !Number.isFinite(Date.parse(rfq.requiredBy)) ||
      !Number.isFinite(Date.parse(rfq.expiresAt))
    ) {
      throw new Error("Synthetic RFQ is invalid");
    }
    if (Date.parse(rfq.expiresAt) <= this.clock().getTime()) {
      throw new Error("Synthetic RFQ has expired");
    }
    if (requestedProfileId && requestedProfileId !== rfq.profileId) {
      throw new Error("Synthetic RFQ does not belong to the requested supplier profile");
    }
    const profile = await this.store.getProfile(rfq.profileId);
    if (!profile) throw new Error("Unknown synthetic supplier profile");
    if (!Number.isFinite(profile.baseUnitPrice) || profile.baseUnitPrice < 0) {
      throw new Error("Synthetic supplier profile is invalid");
    }
    if (profile.datasetVersion !== rfq.datasetVersion) {
      throw new Error("Synthetic RFQ dataset version does not match the supplier profile");
    }
    return { rfq, profile };
  }

  async resolveContext(
    rfqId: string,
    requestedProfileId?: SyntheticRfq["profileId"],
  ): Promise<{ rfq: SyntheticRfq; profile: SyntheticSupplierProfile }> {
    const rfq = await this.store.resolveRfq(rfqId);
    if (rfq?.rfqId !== rfqId) throw new Error("Synthetic RFQ lookup mismatch");
    return this.validateContext(rfq, requestedProfileId);
  }

  async resolveRoutingContext(
    routingCode: string,
    requestedProfileId?: SyntheticRfq["profileId"],
  ): Promise<{ rfq: SyntheticRfq; profile: SyntheticSupplierProfile }> {
    if (!/^\d{6}$/.test(routingCode)) {
      throw new Error("Synthetic routing code is invalid");
    }
    const rfq = await this.store.resolveRoutingCode(routingCode);
    if (rfq?.routingCode !== routingCode) {
      throw new Error("Synthetic routing lookup mismatch");
    }
    return this.validateContext(rfq, requestedProfileId);
  }

  async respond(request: SupplierSimulatorRequest): Promise<SupplierSimulatorResponse> {
    const { rfq, profile } = await this.resolveContext(
      request.rfqId,
      request.profileId,
    );
    const quote = quoteFor(profile, rfq);
    return {
      intent: request.intent,
      quote,
      message: localizedMessage(profile.locale, request.intent, quote),
      continueConversation: request.intent !== "EndConversation",
    };
  }
}

export function toMockSupplierResult(quote: SyntheticSupplierQuote): MockSupplierResult {
  return {
    skuConfirmed: quote.skuConfirmed,
    availableQuantity: quote.availableQuantity,
    unitPrice: quote.unitPrice,
    currency: quote.currency,
    deliveryAt: quote.deliveryAt,
    offerValidUntil: quote.offerValidUntil,
    commercialTermsChanged: quote.commercialTermsChanged,
    optOutRequested: false,
    notes: `Synthetic Supplier Simulator ${quote.profileId}; state ${quote.state}; dataset ${quote.datasetVersion}.`,
  };
}
