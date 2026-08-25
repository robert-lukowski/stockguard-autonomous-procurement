import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallEApiAdapter,
  CallSafetyError,
  DEFAULT_CALLE_HTTP_TIMEOUT_MS,
  MockCallEAdapter,
  type CallAuthorization,
  type SupplierCallRequest,
} from ".";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(options.signal).toBeInstanceOf(AbortSignal);

    const logged = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logged).toContain("CALLE_CALL_CREATE_STARTED");
    expect(logged).toContain("CALLE_CALL_CREATE_SUCCEEDED");
    expect(logged).toContain("call-test-01");
    expect(logged).toContain("httpElapsedMs");
    expect(logged).not.toContain("test-only");
    expect(logged).not.toContain(request.phoneE164);
  });

  it("uses a 30-second default and abortable HTTP for call creation and polling", async () => {
    expect(DEFAULT_CALLE_HTTP_TIMEOUT_MS).toBe(30_000);
    const signals: AbortSignal[] = [];
    const fetchImplementation = vi.fn(
      (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("Expected an AbortSignal");
        }
        signals.push(signal);
        if (signals.length === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ call_id: "call-real-01", status: "queued" })),
          );
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation,
      httpTimeoutMs: 5,
    });

    const created = await adapter.startSupplierCall(request, authorization);
    await expect(adapter.getSupplierCall(created.callId)).rejects.toThrow(
      "CALL_TIMEOUT",
    );

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain(
      '"event":"CALLE_POLL_FAILED","category":"TIMEOUT"',
    );
  });

  it("logs non-2xx status without credentials or destination data", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response("unavailable", { status: 503 }),
    );
    const adapter = new CallEApiAdapter({
      apiKey: "secret-test-key",
      realCallsEnabled: true,
      fetchImplementation,
    });

    await expect(
      adapter.startSupplierCall(request, authorization),
    ).rejects.toThrow("HTTP 503");

    const warned = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(warned).toContain("CALLE_HTTP_NON_2XX");
    expect(warned).toContain('"httpStatus":503');
    expect(warned).not.toContain("secret-test-key");
    expect(warned).not.toContain(request.phoneE164);
  });

  it("logs a terminal status when polling reaches one", async () => {
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ call_id: "call-terminal", status: "failed" })),
      ),
    });

    await adapter.getSupplierCall("call-terminal");

    const logged = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logged).toContain("CALLE_TERMINAL_STATUS");
    expect(logged).toContain("call-terminal");
    expect(logged).toContain('"status":"failed"');
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
        region: "US",
        allowedProfileIds: ["DE_SUPPLIER"],
      },
    });

    await adapter.startSupplierCall(syntheticRequest, authorization);

    const [, options] = fetchImplementation.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.recipients[0].region).toBe("US");
    expect(body.task).toContain("routing code 2 8 1 0 0 1");
    expect(body.metadata).toMatchObject({
      workflow_run_id: request.workflowId,
      counterparty_mode: "synthetic-supplier-simulator",
      synthetic_rfq_id: "RFQ-DE-081",
      synthetic_routing_code: "281001",
      synthetic_supplier_profile: "DE_SUPPLIER",
    });
  });

  it("skips the routing-code prompt for the fixed English qualification endpoint", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ call_id: "call-en-qualification", status: "queued" }),
        { status: 200 },
      ),
    );
    const syntheticRequest: SupplierCallRequest = {
      ...request,
      supplierId: "supplier-en-01",
      supplierName: "Ridgeline Industrial Supply",
      locale: "en-US",
      region: "US",
      syntheticRouting: {
        kind: "SYNTHETIC_SUPPLIER_SIMULATOR",
        rfqId: "RFQ-EN-QUALIFICATION",
        routingCode: "000001",
        supplierProfileId: "EN_SUPPLIER",
        datasetVersion: "synthetic-suppliers-2026-08-v1",
      },
    };
    const syntheticAuthorization: CallAuthorization = {
      ...authorization,
      allowedSupplierIds: [syntheticRequest.supplierId],
      allowedPhoneNumbers: [syntheticRequest.phoneE164],
    };
    const adapter = new CallEApiAdapter({
      apiKey: "test-only",
      realCallsEnabled: true,
      fetchImplementation,
      syntheticSupplierSimulator: {
        enabled: true,
        phoneE164: syntheticRequest.phoneE164,
        region: "US",
        allowedProfileIds: ["EN_SUPPLIER"],
        routingMode: "fixed-qualification",
      },
    });

    await adapter.startSupplierCall(syntheticRequest, syntheticAuthorization);

    const [, options] = fetchImplementation.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.task).not.toContain("routing code 0 0 0 0 0 1");
    expect(body.task).not.toMatch(
      /fictional test organization|fictional organization|fake company|test harness/i,
    );
    expect(body.task).toContain("calling on behalf of StockGuard");
    expect(body.task).toContain(
      "The automated supplier speaks first",
    );
    expect(body.task).toContain(
      "opening greeting ends with the exact phrase 'Please go ahead.'",
    );
    expect(body.task).toContain(
      "Do not begin your introduction or qualification question before you hear that phrase",
    );
    expect(body.task).toContain(
      "If the recipient is speaking, never talk over them",
    );
    expect(body.task).toContain("already pinned to the English qualification profile");
    expect(body.task).toContain(
      "naturally ask about availability for 8 units of CF-220",
    );
    expect(body.task).toContain(
      "combine the required disclosure and the first concrete procurement question for 8 units of CF-220 in one continuous turn",
    );
    expect(body.task).toContain(
      "Do not stop after the disclosure or yield the turn before asking that concrete procurement question",
    );
    expect(body.task).toContain(
      "Do not say filler acknowledgements such as 'I'm here' after the disclosure",
    );
    expect(body.task).toContain(
      "Refer to the requested product code naturally as 'CF-220'",
    );
    expect(body.task).toContain(
      "Never describe capitalization, punctuation, hyphens, or identifier formatting",
    );
    expect(body.task).toContain(
      "Once all required qualification facts are known, thank the recipient, say goodbye, and end the call",
    );
    expect(body.task).toContain("Do not ask open-ended closing questions");
    expect(body.task).toContain("Do not ask for supplier references, quote references");
    expect(body.task).toContain("Do not reconfirm facts already clearly stated");
    expect(body.task).toContain("Do not use health-check questions");
    expect(body.task).toContain("rephrase the current question once");
    expect(body.task).toContain("Track which qualification fields have already been explicitly confirmed");
    expect(body.task).not.toContain("RFQ-EN-QUALIFICATION");
    expect(body.task).not.toContain("EN_SUPPLIER");
    expect(body.task).not.toContain("synthetic-suppliers-2026-08-v1");
    expect(body.task).not.toContain(request.workflowId);
    expect(body.metadata).toMatchObject({
      workflow_run_id: request.workflowId,
      synthetic_rfq_id: "RFQ-EN-QUALIFICATION",
      synthetic_routing_code: "000001",
      synthetic_supplier_profile: "EN_SUPPLIER",
      synthetic_dataset_version: "synthetic-suppliers-2026-08-v1",
    });
    expect(body.recipients[0]).toEqual({
      phones: [syntheticRequest.phoneE164],
      region: "US",
      locale: "en-US",
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
          recipients: [{
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
              fieldEvidence: {},
            },
          }],
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
