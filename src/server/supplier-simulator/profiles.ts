import type {
  SupplierProfileId,
  SyntheticRfq,
  SyntheticSupplierProfile,
  SyntheticSupplierStore,
} from "./types";

export const syntheticSupplierProfiles: Record<
  SupplierProfileId,
  SyntheticSupplierProfile
> = {
  DE_SUPPLIER: {
    profileId: "DE_SUPPLIER",
    supplierId: "supplier-de-01",
    supplierName: "NordWerk Supply",
    locale: "de_DE",
    currency: "EUR",
    baseUnitPrice: 42,
    state: "PARTIAL_STOCK",
    datasetVersion: "synthetic-suppliers-2026-08-v1",
  },
  FR_SUPPLIER: {
    profileId: "FR_SUPPLIER",
    supplierId: "supplier-fr-01",
    supplierName: "Fourniture Atlas",
    locale: "fr_FR",
    currency: "EUR",
    baseUnitPrice: 38,
    state: "LATE_DELIVERY",
    datasetVersion: "synthetic-suppliers-2026-08-v1",
  },
  PL_SUPPLIER: {
    profileId: "PL_SUPPLIER",
    supplierId: "supplier-pl-01",
    supplierName: "PolStock Components",
    locale: "pl_PL",
    currency: "PLN",
    baseUnitPrice: 158,
    state: "CHANGED_PAYMENT_TERMS",
    datasetVersion: "synthetic-suppliers-2026-08-v1",
  },
};

export class InMemorySyntheticSupplierStore implements SyntheticSupplierStore {
  private readonly profiles = new Map<SupplierProfileId, SyntheticSupplierProfile>();
  private readonly rfqs = new Map<string, SyntheticRfq>();

  constructor(
    profiles: SyntheticSupplierProfile[] = Object.values(syntheticSupplierProfiles),
    rfqs: SyntheticRfq[] = [],
  ) {
    for (const profile of profiles) {
      this.profiles.set(profile.profileId, structuredClone(profile));
    }
    for (const rfq of rfqs) this.rfqs.set(rfq.rfqId, structuredClone(rfq));
  }

  async getProfile(
    profileId: SupplierProfileId,
  ): Promise<SyntheticSupplierProfile | null> {
    const profile = this.profiles.get(profileId);
    return profile ? structuredClone(profile) : null;
  }

  async resolveRfq(rfqId: string): Promise<SyntheticRfq | null> {
    const rfq = this.rfqs.get(rfqId);
    return rfq ? structuredClone(rfq) : null;
  }

  setProfile(profile: SyntheticSupplierProfile): void {
    this.profiles.set(profile.profileId, structuredClone(profile));
  }

  setRfq(rfq: SyntheticRfq): void {
    this.rfqs.set(rfq.rfqId, structuredClone(rfq));
  }
}
