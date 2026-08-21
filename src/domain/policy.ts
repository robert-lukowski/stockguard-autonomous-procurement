import type {
  NormalizedOffer,
  PolicyCheck,
  ProcurementPolicy,
  ShortageForecast,
  ValidationResult,
} from "./types";

function check(id: string, passed: boolean, evidence: string): PolicyCheck {
  return { id, passed, evidence };
}

export function validateOffer(
  offer: NormalizedOffer,
  forecast: ShortageForecast,
  policy: ProcurementPolicy,
): ValidationResult {
  const checks: PolicyCheck[] = [
    check(
      "approved_supplier",
      offer.approvedSupplier,
      offer.approvedSupplier
        ? `${offer.supplierName} is on the approved supplier list`
        : `${offer.supplierName} is not approved`,
    ),
    check(
      "recipient_consent",
      offer.consentVerified,
      offer.consentVerified
        ? "Recipient consent is registered"
        : "Recipient consent is missing",
    ),
    check(
      "exact_sku",
      offer.exactSkuConfirmed && offer.sku === forecast.sku,
      `Expected ${forecast.sku}; received ${offer.sku}`,
    ),
    check(
      "quantity_sufficient",
      offer.availableQuantity >= forecast.requiredQuantity,
      `${offer.availableQuantity} offered; ${forecast.requiredQuantity} required`,
    ),
    check(
      "delivery_before_stockout",
      Date.parse(offer.deliveryAt) <= Date.parse(forecast.stockoutAt),
      `Delivery ${offer.deliveryAt}; stockout ${forecast.stockoutAt}`,
    ),
    check(
      "unit_price_within_ceiling",
      offer.unitPriceEur <= policy.unitPriceCeilingEur,
      `€${offer.unitPriceEur.toFixed(2)} per unit; ceiling €${policy.unitPriceCeilingEur.toFixed(2)}`,
    ),
    check(
      "total_within_autonomy_limit",
      offer.totalPriceEur <= policy.autonomousOrderLimitEur,
      `€${offer.totalPriceEur.toFixed(2)} total; limit €${policy.autonomousOrderLimitEur.toFixed(2)}`,
    ),
    check(
      "approved_currency",
      policy.approvedCurrencies.includes(offer.currency),
      `${offer.currency} checked against approved currencies`,
    ),
    check(
      "commercial_terms_unchanged",
      !offer.commercialTermsChanged,
      offer.commercialTermsChanged
        ? "Supplier introduced new commercial terms"
        : "No new commercial terms detected",
    ),
    check(
      "evidence_complete",
      offer.evidenceComplete,
      offer.evidenceComplete
        ? "All mandatory evidence fields are present"
        : "Mandatory evidence is incomplete",
    ),
    check(
      "confidence_threshold",
      offer.completionConfidence >= policy.minimumConfidence,
      `${Math.round(offer.completionConfidence * 100)}% confidence; minimum ${Math.round(policy.minimumConfidence * 100)}%`,
    ),
    check(
      "retry_policy",
      offer.attemptCount <= policy.maximumAttempts,
      `${offer.attemptCount} attempts; maximum ${policy.maximumAttempts}`,
    ),
  ];

  const failedCheckIds = checks
    .filter((item) => !item.passed)
    .map((item) => item.id);

  return {
    decision: failedCheckIds.length === 0 ? "PASS" : "BLOCK",
    checks,
    policyVersion: policy.version,
    failedCheckIds,
  };
}
