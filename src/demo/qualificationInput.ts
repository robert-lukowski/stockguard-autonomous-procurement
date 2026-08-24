import type { ExchangeRatesToEur, ProcurementPolicy } from "../domain";
import { syntheticSupplierProfiles } from "../server/supplier-simulator";
import type { WorkflowInput } from "../server/workflow";

const policy: ProcurementPolicy = {
  version: "PROCUREMENT-2026-08-v3",
  autonomousOrderLimitEur: 500,
  unitPriceCeilingEur: 45,
  minimumConfidence: 0.9,
  maximumAttempts: 1,
  approvedCurrencies: ["EUR", "PLN"],
};

const exchangeRates: ExchangeRatesToEur = {
  EUR: 1,
  PLN: 0.2329,
  USD: 0.86,
  GBP: 1.16,
};

export type QualificationInputConfig = {
  workflowId: string;
  phoneE164: string;
  sku: string;
  quantity: number;
  requiredBy: string;
  now: Date;
};

/**
 * Build the one fixed live qualification scenario used by the public judge UI.
 *
 * The caller chooses none of these values. The destination, supplier profile,
 * material and deadline all come from server-side configuration. EN_SUPPLIER
 * deliberately changes payment terms, so a successful call must end in human
 * escalation and can never create an autonomous purchase order.
 */
export function buildQualificationInput(
  config: QualificationInputConfig,
): WorkflowInput {
  if (!/^\+1\d{10}$/.test(config.phoneE164)) {
    throw new Error("Qualification target must be the configured US +1 number");
  }
  if (!Number.isInteger(config.quantity) || config.quantity <= 0) {
    throw new Error("Qualification quantity must be a positive integer");
  }

  const profile = syntheticSupplierProfiles.EN_SUPPLIER;
  const expiresAt = new Date(config.now.getTime() + 15 * 60_000).toISOString();
  const supplierId = "supplier-en-01";

  return {
    workflowId: config.workflowId,
    inventory: {
      sku: config.sku,
      onHand: 8,
      confirmedDemand: config.quantity + 6,
      inboundConfirmed: 0,
      safetyStock: 2,
      stockoutAt: config.requiredBy,
    },
    suppliers: [
      {
        supplierId,
        supplierName: profile.supplierName,
        phoneE164: config.phoneE164,
        region: "US",
        locale: "en-US",
        approved: true,
        consentVerified: true,
        syntheticRouting: {
          kind: "SYNTHETIC_SUPPLIER_SIMULATOR",
          rfqId: "RFQ-EN-QUALIFICATION",
          routingCode: "000001",
          supplierProfileId: "EN_SUPPLIER",
          datasetVersion: profile.datasetVersion,
        },
      },
    ],
    callAuthorization: {
      workflowId: config.workflowId,
      approvedBy: "judge-live-demo",
      approvedAt: config.now.toISOString(),
      expiresAt,
      maximumCalls: 1,
      allowedSupplierIds: [supplierId],
      allowedPhoneNumbers: [config.phoneE164],
    },
    procurementPolicy: policy,
    exchangeRates,
    autonomousExecutionEnabled: true,
  };
}
