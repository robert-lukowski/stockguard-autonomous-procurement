import { describe, expect, it } from "vitest";
import { calculateShortage, selectBestCompliantOffer } from "../../domain";
import type { ProcurementPolicy, SupplierOffer } from "../../domain";
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  callELocaleFor,
  syntheticSupplierProfiles,
  toMockSupplierResult,
  type SyntheticRfq,
} from ".";

const rfq: SyntheticRfq = {
  runId: "qual-run-1",
  rfqId: "RFQ-EN-QUAL-1",
  routingCode: "100001",
  profileId: "EN_SUPPLIER",
  datasetVersion: "synthetic-suppliers-2026-08-v1",
  sku: "CF-220",
  requestedQuantity: 8,
  requiredBy: "2026-08-28T12:00:00+02:00",
  expiresAt: "2099-01-01T00:00:00Z",
};

function service() {
  return new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(undefined, [rfq]),
    () => new Date("2026-08-21T10:30:00Z"),
  );
}

describe("English synthetic supplier", () => {
  it("is registered with a Lex en_US locale", () => {
    const profile = syntheticSupplierProfiles.EN_SUPPLIER;
    expect(profile.locale).toBe("en_US");
    expect(profile.state).toBe("CHANGED_PAYMENT_TERMS");
    expect(profile.supplierId).toBe("supplier-en-01");
  });

  it("maps Lex locale ids onto CALL-E spoken locales without mixing forms", () => {
    expect(callELocaleFor("en_US")).toBe("en-US");
    expect(callELocaleFor("de_DE")).toBe("de-DE");
    expect(callELocaleFor("fr_FR")).toBe("fr-FR");
    expect(callELocaleFor("pl_PL")).toBe("pl-PL");
  });

  it("answers deterministically in English", async () => {
    const first = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const second = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });

    expect(first.message).toBe(second.message);
    expect(first.message).toContain("units are available");
    expect(first.quote.locale).toBe("en_US");
    expect(first.quote.deterministic).toBe(true);

    // The message must speak real values, not literal template placeholders.
    // "units are available" is fixed text and survives an un-interpolated
    // template, so it cannot catch that bug on its own - these assertions can.
    expect(first.message).not.toContain("${");
    expect(first.message).toContain(rfq.rfqId);
    expect(first.message).toContain(String(first.quote.availableQuantity));
    expect(first.message).toContain(first.quote.unitPrice.toFixed(2));
    expect(first.message).toContain(first.quote.currency);
    expect(first.message).toContain(first.quote.deliveryAt.slice(0, 10));
  });

  it("interpolates every English intent that carries quote values", async () => {
    // GetSupplierQuote is exercised above; the other two value-bearing English
    // intents shared the same placeholder bug and need the same guard.
    for (const intent of ["CheckRemainingQuantity", "ConfirmOfferValidity"] as const) {
      const response = await service().respond({
        intent,
        rfqId: rfq.rfqId,
        profileId: "EN_SUPPLIER",
      });
      expect(response.message).not.toContain("${");
    }

    const validity = await service().respond({
      intent: "ConfirmOfferValidity",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    expect(validity.message).toContain(validity.quote.offerValidUntil.slice(0, 10));
  });

  it("states the changed commercial terms in English", async () => {
    const response = await service().respond({
      intent: "ConfirmCommercialTerms",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });

    expect(response.quote.commercialTermsChanged).toBe(true);
    expect(response.message).toContain("advance payment");
  });

  it("cannot accidentally produce a compliant offer", async () => {
    const response = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const mock = toMockSupplierResult(response.quote);

    const offer: SupplierOffer = {
      offerId: "offer-en",
      supplierId: response.quote.supplierId,
      supplierName: response.quote.supplierName,
      approvedSupplier: true,
      consentVerified: true,
      language: "en-US",
      sku: rfq.sku,
      exactSkuConfirmed: true,
      availableQuantity: mock.availableQuantity ?? 0,
      unitPrice: mock.unitPrice ?? 0,
      currency: mock.currency ?? "EUR",
      deliveryAt: mock.deliveryAt ?? "",
      offerValidUntil: mock.offerValidUntil,
      commercialTermsChanged: mock.commercialTermsChanged ?? true,
      evidenceComplete: true,
      evidenceStatus: {
        skuConfirmed: "VERIFIED",
        availableQuantity: "VERIFIED",
        unitPrice: "VERIFIED",
        currency: "VERIFIED",
        deliveryAt: "VERIFIED",
        offerValidUntil: "VERIFIED",
        commercialTermsChanged: "VERIFIED",
      },
      evidenceByField: {},
      completionConfidence: 0.95,
      attemptCount: 1,
    };
    const policy: ProcurementPolicy = {
      version: "TEST-v1",
      autonomousOrderLimitEur: 5000,
      unitPriceCeilingEur: 100,
      minimumConfidence: 0.9,
      maximumAttempts: 2,
      approvedCurrencies: ["EUR"],
    };
    const forecast = calculateShortage({
      sku: "CF-220",
      onHand: 8,
      confirmedDemand: 14,
      inboundConfirmed: 0,
      safetyStock: 2,
      stockoutAt: rfq.requiredBy,
    });

    const decision = selectBestCompliantOffer(
      [offer],
      forecast,
      policy,
      { EUR: 1, PLN: 0.2329, USD: 0.86, GBP: 1.16 },
      "2026-08-21T10:30:00Z",
    );

    // Even with a generous budget and full evidence, changed terms must hold
    // the run back for a human rather than create a purchase order.
    expect(decision.status).toBe("HUMAN_EXCEPTION_REQUIRED");
    expect(
      decision.rejectedOffers[0].validation.humanReviewCheckIds,
    ).toContain("commercial_terms_unchanged");
  });

  it("leaves the Polish supplier in place for the existing demo", () => {
    expect(syntheticSupplierProfiles.PL_SUPPLIER).toBeDefined();
    expect(syntheticSupplierProfiles.PL_SUPPLIER.locale).toBe("pl_PL");
  });
});
