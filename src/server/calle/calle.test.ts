import { describe, expect, it, vi } from "vitest";
import {
  CallEApiAdapter,
  CallSafetyError,
  MockCallEAdapter,
  type CallAuthorization,
  type SupplierCallRequest,
} from ".";

const request: SupplierCallRequest = {
  workflowId: "wf-2026-081",
  attemptNumber: 1,
  supplierId: "supplier-de-01",
  supplierName: "NordWerk Supply",
  phoneE164: "+15550100001",
  region: "DE",
  locale: "de-DE",
  sku: "CF-220",
  requestedQuantity: 8,
  requiredBy: "2026-08-28T12:00:00+02:00",
  consentVerified: true,
};

const authorization: CallAuthorization = {
  workflowId: request.workflowId,
  approvedBy: "demo-operator",
  approvedAt: "2026-08-21T09:00:00Z",
  expiresAt: "2099-08-21T10:00:00Z",
  maximumCalls: 3,
  allowedSupplierIds: ["supplier-de-01"],
  allowedPhoneNumbers: [request.phoneE164],
};

describe("MockCallEAdapter", () => {
  it("returns a schema-shaped multilingual result without a real call", async () => {
    const adapter = new MockCallEAdapter();
    const result = await adapter.startSupplierCall(request, authorization);

    expect(result.status).toBe("completed");
    expect(result.structuredResult).toMatchObject({
      supplierId: "supplier-de-01",
      language: "de-DE",
      availableQuantity: 8,
      currency: "EUR",
    });
    expect(result.schemaValidation).toMatchObject({ valid: true, issues: [] });
    expect(result.fieldEvidence.unitPrice).toMatchObject({
      verified: true,
      source: "transcript",
    });
  });

  it("blocks a number outside the approved allowlist", async () => {
    const adapter = new MockCallEAdapter();

    await expect(
      adapter.startSupplierCall(
        { ...request, phoneE164: "+15550100002" },
        authorization,
      ),
    ).rejects.toMatchObject({ code: "NUMBER_NOT_ALLOWED" });
  });

  it("blocks a recipient without verified consent", async () => {
    const adapter = new MockCallEAdapter();

    await expect(
      adapter.startSupplierCall(
        { ...request, consentVerified: false },
        authorization,
      ),
    ).rejects.toMatchObject({ code: "CONSENT_MISSING" });
  });
});

describe("CallEApiAdapter", () => {
  it("fails closed while real calls are disabled", async () => {
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: false,
      fetchImplementation: vi.fn(),
    });

    await expect(
      adapter.startSupplierCall(request, authorization),
    ).rejects.toEqual(
      new CallSafetyError("Real CALL-E calls are disabled", "REAL_CALLS_DISABLED"),
    );
  });

  it("uses the approved locale and structured schema when enabled", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          call_id: "call-test-01",
          status: "queued",
          task_completed: false,
        }),
        { status: 200 },
      ),
    );

    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation,
    });

    await adapter.startSupplierCall(request, authorization);

    const [, options] = fetchImplementation.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.recipients[0]).toEqual({
      phones: [request.phoneE164],
      region: "DE",
      locale: "de-DE",
    });
    expect(body.recipient_result_schema.required).toContain("unitPrice");
    expect(options.headers["Idempotency-Key"]).toBe(
      "wf-2026-081:supplier-de-01:attempt:1",
    );
    expect(body.metadata.counterparty_mode).toBe("approved-supplier");
  });

  it("routes an allowlisted synthetic RFQ through the configured Connect number", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ call_id: "call-simulator-01", status: "queued" }),
        { status: 200 },
      ),
    );
    const syntheticRequest: SupplierCallRequest = {
      ...request,
      syntheticRouting: {
        kind: "SYNTHETIC_SUPPLIER_SIMULATOR",
        rfqId: "RFQ-DE-081",
        routingCode: "281001",
        supplierProfileId: "DE_SUPPLIER",
        datasetVersion: "synthetic-suppliers-2026-08-v1",
      },
    };
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation,
      syntheticSupplierSimulator: {
        enabled: true,
        phoneE164: request.phoneE164,
        allowedProfileIds: ["DE_SUPPLIER"],
      },
    });

    await adapter.startSupplierCall(syntheticRequest, authorization);

    const [, options] = fetchImplementation.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.task).toContain("routing code 2 8 1 0 0 1");
    expect(body.metadata).toMatchObject({
      workflow_run_id: request.workflowId,
      counterparty_mode: "synthetic-supplier-simulator",
      synthetic_rfq_id: "RFQ-DE-081",
      synthetic_routing_code: "281001",
      synthetic_supplier_profile: "DE_SUPPLIER",
    });
  });

  it("fails closed when simulator routing is not explicitly enabled", async () => {
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation: vi.fn(),
    });

    await expect(
      adapter.startSupplierCall(
        {
          ...request,
          syntheticRouting: {
            kind: "SYNTHETIC_SUPPLIER_SIMULATOR",
            rfqId: "RFQ-DE-081",
            routingCode: "281001",
            supplierProfileId: "DE_SUPPLIER",
            datasetVersion: "synthetic-suppliers-2026-08-v1",
          },
        },
        authorization,
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_SIMULATOR_DISABLED" });
  });

  it("quarantines an invalid structured result from the policy workflow", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          call_id: "call-invalid-01",
          status: "completed",
          task_completed: true,
          structured_result: {
            supplierId: "supplier-de-01",
            language: "de-DE",
            skuConfirmed: true,
            availableQuantity: 8,
            unitPrice: 42,
            currency: "INVALID",
            deliveryAt: "not-a-date",
            offerValidUntil: null,
            commercialTermsChanged: false,
            optOutRequested: false,
            notes: null,
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation,
    });

    const result = await adapter.startSupplierCall(request, authorization);

    expect(result.schemaValidation.valid).toBe(false);
    expect(result.structuredResult).toBeNull();
    expect(result.schemaValidation.issues.map(({ field }) => field)).toEqual(
      expect.arrayContaining(["currency", "deliveryAt"]),
    );
  });
});
