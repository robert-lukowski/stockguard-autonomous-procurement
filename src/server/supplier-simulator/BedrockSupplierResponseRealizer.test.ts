import { describe, expect, it, vi } from "vitest";
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  realizeSupplierResponse,
  type SupplierResponseRealizationRequest,
  type SyntheticRfq,
} from ".";
import {
  BEDROCK_SUPPLIER_SYSTEM_PROMPT,
  BedrockSupplierResponseRealizer,
  type BedrockConverseClient,
} from "./BedrockSupplierResponseRealizer";

const rfq: SyntheticRfq = {
  runId: "qualification-run",
  rfqId: "RFQ-EN-QUALIFICATION",
  routingCode: "000001",
  profileId: "EN_SUPPLIER",
  datasetVersion: "synthetic-suppliers-2026-08-v1",
  sku: "CF-220",
  requestedQuantity: 8,
  requiredBy: "2026-09-30T12:00:00+02:00",
  expiresAt: "2099-01-01T00:00:00Z",
};

const request: SupplierResponseRealizationRequest = {
  intent: "ConfirmCommercialTerms",
  supplierName: "Ridgeline Industrial Supply",
  sku: "CF-220",
  requestedQuantity: 8,
  availableQuantity: 8,
  unitPrice: 41,
  currency: "EUR",
  deliveryAt: "2026-09-29T10:00:00.000Z",
  offerValidUntil: "2026-09-24T10:00:00.000Z",
  commercialTermsChanged: true,
  commercialTermsSummary: "Payment terms changed from net 30 to advance payment.",
  conversation: [
    { role: "caller", text: "Do you have eight CF 220 units available?" },
    { role: "supplier", text: "Yes, all eight are available." },
    {
      role: "caller",
      text: "What is the price, delivery date, quote validity and payment terms?",
    },
  ],
};

function service(): SupplierSimulatorService {
  return new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(undefined, [rfq]),
    () => new Date("2026-08-25T08:00:00Z"),
  );
}

function response(text = "They are 41 EUR each, delivery is September 29, the quote is valid until September 24, and payment is now required in advance.") {
  return {
    output: {
      message: {
        role: "assistant" as const,
        content: [{ text }],
      },
    },
    $metadata: {},
  };
}

describe("BedrockSupplierResponseRealizer", () => {
  it("sends the full short-call conversation and all authoritative supplier facts", async () => {
    const send = vi.fn().mockResolvedValue(response());
    const realizer = new BedrockSupplierResponseRealizer({
      modelId: "eu.amazon.nova-micro-v1:0",
      timeoutMs: 3_000,
      client: { send } as BedrockConverseClient,
    });

    await expect(realizer.realize(request)).resolves.toContain("41 EUR");

    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0];
    expect(command.input).toMatchObject({
      modelId: "eu.amazon.nova-micro-v1:0",
      inferenceConfig: { temperature: 0.4, maxTokens: 160 },
    });
    const systemPrompt = command.input.system?.[0]?.text ?? "";
    const userPrompt = command.input.messages?.[0]?.content?.[0]?.text ?? "";
    expect(systemPrompt).toBe(BEDROCK_SUPPLIER_SYSTEM_PROMPT);
    expect(systemPrompt).toContain("Use only the supplier data");
    expect(systemPrompt).toContain("Answer all parts");
    expect(userPrompt).toContain('"conversation"');
    expect(userPrompt).toContain("Do you have eight CF 220 units available?");
    expect(userPrompt).toContain("price, delivery date, quote validity and payment terms");
    expect(userPrompt).toContain('"sku":"CF-220"');
    expect(userPrompt).toContain('"availableQuantity":8');
    expect(userPrompt).toContain('"unitPrice":41');
    expect(userPrompt).toContain('"currency":"EUR"');
    expect(userPrompt).toContain('"deliveryAt":"2026-09-29');
    expect(userPrompt).toContain('"offerValidUntil":"2026-09-24');
    expect(userPrompt).toContain('"commercialTermsChanged":true');
    expect(userPrompt).toContain("advance payment");
    expect(userPrompt).not.toContain("RFQ-EN-QUALIFICATION");
    expect(userPrompt).not.toContain("qualification-run");
    expect(userPrompt).not.toContain("synthetic-suppliers-2026-08-v1");
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("falls back after the Bedrock timeout without changing deterministic facts", async () => {
    const send = vi.fn((
      _command: unknown,
      options?: { abortSignal?: AbortSignal },
    ) => new Promise((_, reject) => {
      options?.abortSignal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    }));
    const realizer = new BedrockSupplierResponseRealizer({
      modelId: "eu.amazon.nova-micro-v1:0",
      timeoutMs: 5,
      client: { send } as BedrockConverseClient,
    });
    const deterministic = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const quoteBefore = structuredClone(deterministic.quote);

    const message = await realizeSupplierResponse(realizer, deterministic, request.conversation);

    expect(message).toBe(deterministic.message);
    expect(deterministic.quote).toEqual(quoteBefore);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["exception", vi.fn().mockRejectedValue(new Error("service error"))],
    ["empty response", vi.fn().mockResolvedValue(response(""))],
  ])("uses the deterministic fallback for %s", async (_name, send) => {
    const deterministic = await service().respond({
      intent: "ConfirmCommercialTerms",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const realizer = new BedrockSupplierResponseRealizer({
      modelId: "eu.amazon.nova-micro-v1:0",
      timeoutMs: 3_000,
      client: { send } as BedrockConverseClient,
    });

    await expect(
      realizeSupplierResponse(realizer, deterministic, request.conversation),
    ).resolves.toBe(deterministic.message);
  });

  it("logs only realization metadata", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deterministic = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const generated = "Secret generated response text";

    await realizeSupplierResponse(
      { realize: vi.fn().mockResolvedValue(generated) },
      deterministic,
      request.conversation,
    );

    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("supplier_response_realization");
    expect(logged).toContain('"mode":"bedrock"');
    expect(logged).not.toContain(generated);
    expect(logged).not.toContain("CF-220");
    expect(logged).not.toContain("payment terms");
    log.mockRestore();
  });

  it("classifies ValidationException and logs only safe failure metadata", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deterministic = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const sensitiveErrorMessage = "Secret error message containing prompt and transcript";
    const validationError = Object.assign(new Error(sensitiveErrorMessage), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });

    await expect(realizeSupplierResponse(
      { realize: vi.fn().mockRejectedValue(validationError) },
      deterministic,
      request.conversation,
    )).resolves.toBe(deterministic.message);

    const logged = log.mock.calls.flat().join(" ");
    const event = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(event).toMatchObject({
      event: "supplier_response_realization",
      intent: "GetSupplierQuote",
      mode: "deterministic-fallback",
      failureCategory: "validation-error",
      errorName: "ValidationException",
      httpStatusCode: 400,
    });
    expect(event.elapsedMs).toEqual(expect.any(Number));
    expect(event).not.toHaveProperty("errorMessage");
    expect(logged).not.toContain(sensitiveErrorMessage);
    expect(logged).not.toContain("CF-220");
    log.mockRestore();
  });
});
