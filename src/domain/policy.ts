import { roundCurrency } from "./normalization";
import type {
  NormalizedOffer,
  PolicyCheck,
  ProcurementPolicy,
  ShortageForecast,
  ValidationResult,
} from "./types";

type CheckStatus = PolicyCheck["status"];

function check(
  id: string,
  status: CheckStatus,
  evidence: string,
  inputs: PolicyCheck["inputs"],
): PolicyCheck {
  return { id, status, passed: status === "PASS", evidence, inputs };
}

function evidenceAware(
  offer: NormalizedOffer,
  field: keyof NormalizedOffer["evidenceStatus"],
  id: string,
  passed: boolean,
  evidence: string,
  inputs: PolicyCheck["inputs"],
): PolicyCheck {
  if (offer.evidenceStatus[field] !== "VERIFIED") {
    return check(
      id,
      "REQUIRES_HUMAN",
      `${field} is ${offer.evidenceStatus[field].toLowerCase().replace("_", " ")}`,
      inputs,
    );
  }
  return check(id, passed ? "PASS" : "FAIL", evidence, inputs);
}

export function validateOffer(
  offer: NormalizedOffer,
  forecast: ShortageForecast,
  policy: ProcurementPolicy,
  evaluatedAt = new Date().toISOString(),
): ValidationResult {
  const checks: PolicyCheck[] = [
    check(
      "approved_supplier",
      offer.approvedSupplier ? "PASS" : "FAIL",
      offer.approvedSupplier
        ? `${offer.supplierName} is on the approved supplier list`
        : `${offer.supplierName} is not approved`,
      { supplierId: offer.supplierId, approved: offer.approvedSupplier },
    ),
    check(
      "recipient_consent",
      offer.consentVerified ? "PASS" : "FAIL",
      offer.consentVerified
        ? "Recipient consent is registered"
        : "Recipient consent is missing",
      { consentVerified: offer.consentVerified },
    ),
    evidenceAware(
      offer,
      "skuConfirmed",
      "exact_sku",
      offer.exactSkuConfirmed && offer.sku === forecast.sku,
      `Expected ${forecast.sku}; received ${offer.sku}`,
      { expectedSku: forecast.sku, receivedSku: offer.sku, confirmed: offer.exactSkuConfirmed },
    ),
    evidenceAware(
      offer,
      "availableQuantity",
      "quantity_sufficient",
      offer.availableQuantity >= forecast.requiredQuantity,
      `${offer.availableQuantity} offered; ${forecast.requiredQuantity} required`,
      { offered: offer.availableQuantity, required: forecast.requiredQuantity },
    ),
    evidenceAware(
      offer,
      "deliveryAt",
      "delivery_before_stockout",
      Date.parse(offer.deliveryAt) <= Date.parse(forecast.stockoutAt),
      `Delivery ${offer.deliveryAt}; stockout ${forecast.stockoutAt}`,
      { deliveryAt: offer.deliveryAt, stockoutAt: forecast.stockoutAt },
    ),
    evidenceAware(
      offer,
      "unitPrice",
      "unit_price_within_ceiling",
      offer.unitPriceEur <= policy.unitPriceCeilingEur,
      `€${offer.unitPriceEur.toFixed(2)} per unit; ceiling €${policy.unitPriceCeilingEur.toFixed(2)}`,
      { unitPriceEur: offer.unitPriceEur, ceilingEur: policy.unitPriceCeilingEur },
    ),
    // The PO is created for forecast.requiredQuantity, never for the (possibly
    // larger) offer.availableQuantity - see ProcurementWorkflow's purchase-order
    // construction. Budget must be checked against what will actually be
    // spent, not against a total priced at a quantity nobody is ordering.
    check(
      "total_within_autonomy_limit",
      roundCurrency(offer.unitPriceEur * forecast.requiredQuantity) <=
        policy.autonomousOrderLimitEur
        ? "PASS"
        : "FAIL",
      `€${roundCurrency(offer.unitPriceEur * forecast.requiredQuantity).toFixed(2)} order total for ${forecast.requiredQuantity} units; limit €${policy.autonomousOrderLimitEur.toFixed(2)}`,
      {
        orderTotalEur: roundCurrency(offer.unitPriceEur * forecast.requiredQuantity),
        orderQuantity: forecast.requiredQuantity,
        limitEur: policy.autonomousOrderLimitEur,
      },
    ),
    evidenceAware(
      offer,
      "currency",
      "approved_currency",
      policy.approvedCurrencies.includes(offer.currency),
      `${offer.currency} checked against approved currencies`,
      { currency: offer.currency, approved: policy.approvedCurrencies.join(",") },
    ),
    evidenceAware(
      offer,
      "offerValidUntil",
      "offer_validity",
      offer.offerValidUntil !== null && Date.parse(offer.offerValidUntil) >= Date.parse(evaluatedAt),
      `Offer valid until ${offer.offerValidUntil ?? "not provided"}; evaluated ${evaluatedAt}`,
      { offerValidUntil: offer.offerValidUntil, evaluatedAt },
    ),
    offer.evidenceStatus.commercialTermsChanged !== "VERIFIED"
      ? check(
          "commercial_terms_unchanged",
          "REQUIRES_HUMAN",
          "Commercial-terms evidence is not verified",
          { changed: offer.commercialTermsChanged },
        )
      : check(
          "commercial_terms_unchanged",
          offer.commercialTermsChanged ? "REQUIRES_HUMAN" : "PASS",
          offer.commercialTermsChanged
            ? "Supplier introduced new commercial terms requiring human approval"
            : "No new commercial terms detected",
          { changed: offer.commercialTermsChanged },
        ),
    check(
      "evidence_complete",
      offer.evidenceComplete ? "PASS" : "REQUIRES_HUMAN",
      offer.evidenceComplete
        ? "Every mandatory field has verified supporting evidence"
        : "At least one mandatory field is missing or unverified",
      { evidenceComplete: offer.evidenceComplete },
    ),
    check(
      "confidence_threshold",
      offer.completionConfidence >= policy.minimumConfidence ? "PASS" : "REQUIRES_HUMAN",
      `${Math.round(offer.completionConfidence * 100)}% confidence; minimum ${Math.round(policy.minimumConfidence * 100)}%`,
      { confidence: offer.completionConfidence, minimum: policy.minimumConfidence },
    ),
    check(
      "retry_policy",
      offer.attemptCount <= policy.maximumAttempts ? "PASS" : "FAIL",
      `${offer.attemptCount} attempts; maximum ${policy.maximumAttempts}`,
      { attempts: offer.attemptCount, maximum: policy.maximumAttempts },
    ),
  ];

  const failedCheckIds = checks
    .filter(({ status }) => status === "FAIL")
    .map(({ id }) => id);
  const humanReviewCheckIds = checks
    .filter(({ status }) => status === "REQUIRES_HUMAN")
    .map(({ id }) => id);

  return {
    decision:
      failedCheckIds.length > 0
        ? "BLOCK"
        : humanReviewCheckIds.length > 0
          ? "REQUIRES_HUMAN"
          : "PASS",
    checks,
    policyVersion: policy.version,
    failedCheckIds,
    humanReviewCheckIds,
  };
}
