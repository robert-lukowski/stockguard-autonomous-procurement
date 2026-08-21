import { describe, expect, it } from "vitest";
import {
  calculateShortage,
  selectBestCompliantOffer,
  validateOffer,
  type ExchangeRatesToEur,
  type ProcurementPolicy,
  type SupplierOffer,
} from ".";

const rates: ExchangeRatesToEur = {
  EUR: 1,
  PLN: 0.2329,
  USD: 0.86,
  GBP: 1.16,
};

const policy: ProcurementPolicy = {
  version: "PROCUREMENT-2026-08-v3",
  autonomousOrderLimitEur: 500,
  unitPriceCeilingEur: 45,
  minimumConfidence: 0.9,
  maximumAttempts: 2,
  approvedCurrencies: ["EUR", "PLN"],
};

const forecast = calculateShortage({
  sku: "CF-220",
  onHand: 8,
  confirmedDemand: 14,
  inboundConfirmed: 0,
  safetyStock: 2,
  stockoutAt: "2026-08-28T12:00:00+02:00",
});

function offer(overrides: Partial<SupplierOffer> = {}): SupplierOffer {
  return {
    offerId: "offer-de-01",
    supplierId: "supplier-de-01",
    supplierName: "NordWerk Supply",
    approvedSupplier: true,
    consentVerified: true,
    language: "de-DE",
    sku: "CF-220",
    exactSkuConfirmed: true,
    availableQuantity: 8,
    unitPrice: 42,
    currency: "EUR",
    deliveryAt: "2026-08-27T10:00:00+02:00",
    commercialTermsChanged: false,
    evidenceComplete: true,
    completionConfidence: 0.96,
    attemptCount: 1,
    ...overrides,
  };
}

describe("calculateShortage", () => {
  it("includes safety stock and confirmed inbound inventory", () => {
    expect(
      calculateShortage({
        sku: "CF-220",
        onHand: 8,
        confirmedDemand: 14,
        inboundConfirmed: 2,
        safetyStock: 2,
        stockoutAt: "2026-08-28T12:00:00+02:00",
      }),
    ).toMatchObject({
      projectedAvailable: 10,
      requiredQuantity: 6,
      shortageDetected: true,
    });
  });

  it("does not create negative replenishment demand", () => {
    expect(
      calculateShortage({
        sku: "CF-220",
        onHand: 20,
        confirmedDemand: 5,
        inboundConfirmed: 0,
        safetyStock: 2,
        stockoutAt: "2026-08-28T12:00:00+02:00",
      }).requiredQuantity,
    ).toBe(0);
  });
});

describe("validateOffer", () => {
  it("passes a complete offer inside the autonomous green zone", () => {
    const result = selectBestCompliantOffer(
      [offer()],
      forecast,
      policy,
      rates,
    );

    expect(result.status).toBe("ORDER_APPROVED");
    expect(result.validation?.checks).toHaveLength(12);
    expect(result.validation?.failedCheckIds).toEqual([]);
  });

  it.each([
    ["unapproved supplier", { approvedSupplier: false }, "approved_supplier"],
    ["late delivery", { deliveryAt: "2026-08-31T10:00:00+02:00" }, "delivery_before_stockout"],
    ["new terms", { commercialTermsChanged: true }, "commercial_terms_unchanged"],
    ["low confidence", { completionConfidence: 0.71 }, "confidence_threshold"],
  ] as const)("blocks %s", (_label, overrides, expectedCheck) => {
    const candidate = offer(overrides);
    const normalized = {
      ...candidate,
      unitPriceEur: candidate.unitPrice,
      totalPriceEur: candidate.unitPrice * candidate.availableQuantity,
    };

    expect(
      validateOffer(normalized, forecast, policy).failedCheckIds,
    ).toContain(expectedCheck);
  });
});

describe("selectBestCompliantOffer", () => {
  it("selects the cheapest offer only after every hard check passes", () => {
    const result = selectBestCompliantOffer(
      [
        offer({ supplierName: "Fast Valid", unitPrice: 42 }),
        offer({
          offerId: "offer-cheap-late",
          supplierName: "Cheap but Late",
          unitPrice: 34,
          deliveryAt: "2026-08-31T10:00:00+02:00",
        }),
        offer({
          offerId: "offer-insufficient",
          supplierName: "Insufficient",
          unitPrice: 37,
          availableQuantity: 6,
        }),
      ],
      forecast,
      policy,
      rates,
    );

    expect(result.status).toBe("ORDER_APPROVED");
    expect(result.selectedOffer?.supplierName).toBe("Fast Valid");
    expect(result.rejectedOffers).toHaveLength(2);
  });

  it("requires human review when no offer is compliant", () => {
    const result = selectBestCompliantOffer(
      [offer({ approvedSupplier: false })],
      forecast,
      policy,
      rates,
    );

    expect(result.status).toBe("HUMAN_EXCEPTION_REQUIRED");
    expect(result.selectedOffer).toBeNull();
  });
});
