import { normalizeOffer } from "./normalization";
import { validateOffer } from "./policy";
import type {
  ExchangeRatesToEur,
  ProcurementDecision,
  ProcurementPolicy,
  ShortageForecast,
  SupplierOffer,
} from "./types";

export function selectBestCompliantOffer(
  offers: SupplierOffer[],
  forecast: ShortageForecast,
  policy: ProcurementPolicy,
  exchangeRates: ExchangeRatesToEur,
): ProcurementDecision {
  if (!forecast.shortageDetected) {
    return {
      status: "HUMAN_EXCEPTION_REQUIRED",
      selectedOffer: null,
      validation: null,
      rejectedOffers: [],
      reason: "No shortage exists, so autonomous procurement is not permitted",
    };
  }

  const evaluated = offers.map((offer) => {
    const normalized = normalizeOffer(offer, exchangeRates);
    return {
      offer: normalized,
      validation: validateOffer(normalized, forecast, policy),
    };
  });

  const compliant = evaluated
    .filter(({ validation }) => validation.decision === "PASS")
    .sort((left, right) => {
      const costDifference =
        left.offer.totalPriceEur - right.offer.totalPriceEur;

      if (costDifference !== 0) return costDifference;

      const deliveryDifference =
        Date.parse(left.offer.deliveryAt) - Date.parse(right.offer.deliveryAt);

      if (deliveryDifference !== 0) return deliveryDifference;

      return (
        right.offer.completionConfidence -
        left.offer.completionConfidence
      );
    });

  const rejectedOffers = evaluated.filter(
    ({ validation }) => validation.decision === "BLOCK",
  );

  if (compliant.length === 0) {
    return {
      status: "HUMAN_EXCEPTION_REQUIRED",
      selectedOffer: null,
      validation: null,
      rejectedOffers,
      reason: "No supplier offer passed every machine-enforced policy check",
    };
  }

  const selected = compliant[0];

  return {
    status: "ORDER_APPROVED",
    selectedOffer: selected.offer,
    validation: selected.validation,
    rejectedOffers,
    reason: `${selected.offer.supplierName} is the lowest-cost offer that satisfies every policy requirement`,
  };
}
