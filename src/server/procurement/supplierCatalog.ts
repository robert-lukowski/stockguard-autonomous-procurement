import type { SupplierProfileId, SyntheticSupplierProfile } from "../supplier-simulator";

/**
 * Which synthetic supplier answers for each catalog SKU.
 *
 * These profiles are declared here rather than imported from
 * `supplier-simulator/profiles.ts` on purpose. That file holds the personas
 * built for the CALL-E telephony qualification, and one of them
 * (`EN_SUPPLIER`) is deliberately pinned to CHANGED_PAYMENT_TERMS so a live
 * call could never produce an autonomous purchase. The Judge Portal needs a
 * different spread of outcomes, and editing the telephony personas to get it
 * would quietly weaken that safety property.
 *
 * The profile IDs are reused unchanged, so no union widens and the CALL-E
 * allowlists are untouched. Only the commercial data differs, and it stays
 * deterministic: the same SKU always yields the same quote.
 */
export const supplierProfilesBySku: Record<string, SyntheticSupplierProfile> = {
  // Priced to fit the 20 x USD 2,500 mission: 20 x 98.00 = 1,960.00.
  "SSD-IND-960": {
    profileId: "EN_SUPPLIER",
    supplierId: "supplier-en-01",
    supplierName: "Ridgeline Industrial Supply",
    locale: "en_US",
    currency: "USD",
    baseUnitPrice: 98,
    state: "AVAILABLE",
    datasetVersion: "judge-portal-suppliers-2026-09-v1",
  },
  // Changed payment terms, so this SKU always lands in human review.
  "NIC-10G-X2": {
    profileId: "DE_SUPPLIER",
    supplierId: "supplier-de-01",
    supplierName: "NordWerk Supply",
    locale: "en_US",
    currency: "USD",
    baseUnitPrice: 210,
    state: "CHANGED_PAYMENT_TERMS",
    datasetVersion: "judge-portal-suppliers-2026-09-v1",
  },
  "RAM-ECC-32": {
    profileId: "FR_SUPPLIER",
    supplierId: "supplier-fr-01",
    supplierName: "Fourniture Atlas",
    locale: "en_US",
    currency: "USD",
    baseUnitPrice: 129,
    state: "AVAILABLE",
    datasetVersion: "judge-portal-suppliers-2026-09-v1",
  },
  // Late delivery, so this SKU always misses the required window.
  "UPS-RACK-3K": {
    profileId: "PL_SUPPLIER",
    supplierId: "supplier-pl-01",
    supplierName: "PolStock Components",
    locale: "en_US",
    currency: "USD",
    baseUnitPrice: 1450,
    state: "LATE_DELIVERY",
    datasetVersion: "judge-portal-suppliers-2026-09-v1",
  },
};

export function supplierProfileForSku(sku: string): SyntheticSupplierProfile | null {
  return supplierProfilesBySku[sku] ?? null;
}

export function supplierProfileIdForSku(sku: string): SupplierProfileId | null {
  return supplierProfilesBySku[sku]?.profileId ?? null;
}
