import { describe, expect, it } from "vitest";
import { buildQualificationInput } from "./qualificationInput";

describe("buildQualificationInput", () => {
  it("builds one fixed English synthetic supplier with a one-call authorization", () => {
    const input = buildQualificationInput({
      workflowId: "live-en-test",
      phoneE164: "+15550100001",
      sku: "CF-220",
      quantity: 8,
      requiredBy: "2026-08-28T12:00:00+02:00",
      now: new Date("2026-08-24T08:00:00Z"),
    });

    expect(input.suppliers).toHaveLength(1);
    expect(input.suppliers[0]).toMatchObject({
      supplierId: "supplier-en-01",
      supplierName: "Ridgeline Industrial Supply",
      phoneE164: "+15550100001",
      region: "US",
      locale: "en-US",
      syntheticRouting: {
        rfqId: "RFQ-EN-QUALIFICATION",
        routingCode: "000001",
        supplierProfileId: "EN_SUPPLIER",
      },
    });
    expect(input.callAuthorization).toMatchObject({
      maximumCalls: 1,
      allowedSupplierIds: ["supplier-en-01"],
      allowedPhoneNumbers: ["+15550100001"],
    });
    expect(input.procurementPolicy.maximumAttempts).toBe(1);
    expect(input.autonomousExecutionEnabled).toBe(true);
  });

  it("rejects any destination outside the fixed US +1 shape", () => {
    expect(() =>
      buildQualificationInput({
        workflowId: "live-en-test",
        phoneE164: "+49123456789",
        sku: "CF-220",
        quantity: 8,
        requiredBy: "2026-08-28T12:00:00+02:00",
        now: new Date("2026-08-24T08:00:00Z"),
      }),
    ).toThrow("Qualification target must be the configured US +1 number");
  });
});
