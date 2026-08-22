import type {
  SupplierProfileId,
  SyntheticProfileUpdate,
  SyntheticRfq,
  SyntheticSupplierAdminPort,
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
  /*
   * English persona for the first live qualification.
   *
   * CHANGED_PAYMENT_TERMS is chosen deliberately: it drives
   * `commercial_terms_unchanged` to REQUIRES_HUMAN in the Policy Gateway, so
   * a successful call can never accidentally produce a compliant offer and
   * create a synthetic purchase order. The qualification proves the telephony
   * and evidence path, not an autonomous purchase.
   *
   * Nationality is a scenario attribute only. Every persona is reached on the
   * same controlled +1 Connect number.
   */
  EN_SUPPLIER: {
    profileId: "EN_SUPPLIER",
    supplierId: "supplier-en-01",
    supplierName: "Ridgeline Industrial Supply",
    locale: "en_US",
    currency: "EUR",
    baseUnitPrice: 41,
    state: "CHANGED_PAYMENT_TERMS",
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

export class InMemorySyntheticSupplierStore
  implements SyntheticSupplierStore, SyntheticSupplierAdminPort
{
  private readonly profiles = new Map<SupplierProfileId, SyntheticSupplierProfile>();
  private readonly rfqs = new Map<string, SyntheticRfq>();
  private readonly rfqIdsByRoutingCode = new Map<string, string>();

  constructor(
    profiles: SyntheticSupplierProfile[] = Object.values(syntheticSupplierProfiles),
    rfqs: SyntheticRfq[] = [],
  ) {
    for (const profile of profiles) {
      this.profiles.set(profile.profileId, structuredClone(profile));
    }
    for (const rfq of rfqs) this.setRfq(rfq);
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

  async resolveRoutingCode(routingCode: string): Promise<SyntheticRfq | null> {
    const rfqId = this.rfqIdsByRoutingCode.get(routingCode);
    return rfqId ? this.resolveRfq(rfqId) : null;
  }

  setProfile(profile: SyntheticSupplierProfile): void {
    this.profiles.set(profile.profileId, structuredClone(profile));
  }

  setRfq(rfq: SyntheticRfq): void {
    const previous = this.rfqs.get(rfq.rfqId);
    if (previous) this.rfqIdsByRoutingCode.delete(previous.routingCode);
    this.rfqs.set(rfq.rfqId, structuredClone(rfq));
    this.rfqIdsByRoutingCode.set(rfq.routingCode, rfq.rfqId);
  }

  async createRfq(rfq: SyntheticRfq): Promise<"CREATED" | "DUPLICATE"> {
    if (
      this.rfqs.has(rfq.rfqId) ||
      this.rfqIdsByRoutingCode.has(rfq.routingCode)
    ) {
      return "DUPLICATE";
    }
    this.setRfq(rfq);
    return "CREATED";
  }

  async updateProfile(
    update: SyntheticProfileUpdate,
  ): Promise<"UPDATED" | "VERSION_CONFLICT"> {
    const current = this.profiles.get(update.profile.profileId);
    if (!current || current.datasetVersion !== update.expectedDatasetVersion) {
      return "VERSION_CONFLICT";
    }
    this.setProfile(update.profile);
    return "UPDATED";
  }
}
