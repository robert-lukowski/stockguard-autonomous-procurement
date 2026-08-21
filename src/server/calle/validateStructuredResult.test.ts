import { describe, expect, it } from "vitest";
import { validateSupplierCallResult } from "./validateStructuredResult";

const validResult = {
  supplierId: "supplier-de-01",
  language: "de-DE",
  skuConfirmed: true,
  availableQuantity: 8,
  unitPrice: 42,
  currency: "EUR",
  deliveryAt: "2026-08-27T10:00:00+02:00",
  offerValidUntil: "2026-08-22T16:00:00+02:00",
  commercialTermsChanged: false,
  optOutRequested: false,
  notes: "Synthetic quote",
  fieldEvidence: {
    skuConfirmed: "Yes, that is CF-220",
    availableQuantity: "We have eight units",
    unitPrice: "The unit price is forty-two",
    currency: "The price is in euro",
    deliveryAt: "Delivery is August twenty-seventh",
    offerValidUntil: "The quote is valid until August twenty-second",
    commercialTermsChanged: "Our commercial terms are unchanged",
  },
};

describe("validateSupplierCallResult", () => {
  it("accepts a schema-compliant structured result", () => {
    expect(validateSupplierCallResult(validResult)).toMatchObject({ valid: true });
  });

  it("rejects invalid numbers, currencies and dates", () => {
    const result = validateSupplierCallResult({
      ...validResult,
      availableQuantity: -1,
      currency: "BTC",
      deliveryAt: "tomorrow-ish",
    });

    expect(result.valid).toBe(false);
    expect(result.result).toBeNull();
    expect(result.issues.map(({ field }) => field)).toEqual(
      expect.arrayContaining(["availableQuantity", "currency", "deliveryAt"]),
    );
  });
});
