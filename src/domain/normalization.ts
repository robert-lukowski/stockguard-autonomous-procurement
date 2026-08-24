import type {
  ExchangeRatesToEur,
  NormalizedOffer,
  SupplierOffer,
} from "./types";

export function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeOffer(
  offer: SupplierOffer,
  exchangeRates: ExchangeRatesToEur,
): NormalizedOffer {
  const rate = exchangeRates[offer.currency];

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Missing or invalid EUR exchange rate for ${offer.currency}`);
  }

  if (!Number.isFinite(offer.unitPrice) || offer.unitPrice < 0) {
    throw new Error("Offer unit price must be a non-negative finite number");
  }

  const unitPriceEur = roundCurrency(offer.unitPrice * rate);

  return {
    ...offer,
    unitPriceEur,
    totalPriceEur: roundCurrency(unitPriceEur * offer.availableQuantity),
  };
}
