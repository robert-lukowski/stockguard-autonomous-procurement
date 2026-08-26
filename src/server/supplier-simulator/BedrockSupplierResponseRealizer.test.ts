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
  intent: "GetSupplierQuote",
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
};

function service(): SupplierSimulatorService {
  return new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(undefined, [rfq]),
    () => new Date("2026-08-25T08:00:00Z"),
  );
}

function response(text = "We have all eight units available at 41 EUR each.") {
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
  it("uses one Converse request with authoritative facts and a short natural prompt", async () => {
    const send = vi.fn().mockResolvedValue(response());
    const realizer = new BedrockSupplierResponseRealizer({
      modelId: "eu.amazon.nova-micro-v1:0",
      timeoutMs: 3_000,
      client: { send } as BedrockConverseClient,
    });

    await expect(realizer.realize(request)).resolves.toBe(
      "We have all eight units available at 41 EUR each.",
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0];
    // 0.4 leaves room for a natural sentence without drifting off the
    // facts; 80 tokens keeps it to one line. Both are pinned deliberately.
    expect(command.input).toMatchObject({
      modelId: "eu.amazon.nova-micro-v1:0",
      inferenceConfig: { temperature: 0.4, maxTokens: 80 },
    });
    const systemPrompt = command.input.system?.[0]?.text ?? "";
    const userPrompt = command.input.messages?.[0]?.content?.[0]?.text ?? "";
    expect(systemPrompt).toBe(BEDROCK_SUPPLIER_SYSTEM_PROMPT);
    expect(systemPrompt).toContain("sales rep");
    expect(systemPrompt).toContain("Use only the facts in the JSON below");
    expect(userPrompt).toContain('"intent":"GetSupplierQuote"');
    expect(userPrompt).toContain('"sku":"CF-220"');
    expect(userPrompt).toContain('"requestedQuantity":8');
    expect(userPrompt).toContain('"availableQuantity":8');
    expect(userPrompt).toContain('"unitPrice":41');
    expect(userPrompt).toContain('"currency":"EUR"');
    expect(userPrompt).toContain('"deliveryAt":"2026-09-29');
    expect(userPrompt).toContain('"offerValidUntil":"2026-09-24');
    // Commercial terms are not part of the quote intent: they belong to
    // ConfirmCommercialTerms and would otherwise be dumped into the quote
    // reply (observed live). The supplier answers what it was asked.
    expect(userPrompt).not.toContain("commercialTermsChanged");
    expect(userPrompt).not.toContain("advance payment");
    // The caller utterance is no longer passed in - the intent is already
    // enough to decide the answer, and passing raw caller text is an
    // avoidable prompt-injection surface.
    expect(userPrompt).not.toMatch(/latestCallerQuestion|Ignore the quote/i);
    expect(userPrompt).not.toContain("RFQ-EN-QUALIFICATION");
    expect(userPrompt).not.toContain("qualification-run");
    expect(userPrompt).not.toContain("synthetic-suppliers-2026-08-v1");
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {
      intent: "ConfirmCommercialTerms" as const,
      mustContain: ['"intent":"ConfirmCommercialTerms"', "advance payment", '"commercialTermsChanged":true'],
      mustNotContain: ['"unitPrice"', '"deliveryAt"', '"offerValidUntil"', '"availableQuantity"'],
    },
    {
      intent: "ConfirmOfferValidity" as const,
      mustContain: ['"intent":"ConfirmOfferValidity"', '"offerValidUntil":"2026-09-24'],
      mustNotContain: ['"unitPrice"', '"deliveryAt"', "commercialTermsChanged", '"availableQuantity"'],
    },
    {
      intent: "CheckRemainingQuantity" as const,
      mustContain: ['"intent":"CheckRemainingQuantity"', '"sku":"CF-220"', '"availableQuantity":8', '"deliveryAt":"2026-09-29'],
      mustNotContain: ['"unitPrice"', '"offerValidUntil"', "commercialTermsChanged"],
    },
    {
      intent: "EndConversation" as const,
      mustContain: ['"intent":"EndConversation"'],
      mustNotContain: ['"unitPrice"', '"deliveryAt"', '"offerValidUntil"', "commercialTermsChanged", '"sku"'],
    },
  ])("scopes the JSON payload to $intent facts only", async ({ intent, mustContain, mustNotContain }) => {
    const send = vi.fn().mockResolvedValue(response("Sure."));
    const realizer = new BedrockSupplierResponseRealizer({
      modelId: "eu.amazon.nova-micro-v1:0",
      timeoutMs: 3_000,
      client: { send } as BedrockConverseClient,
    });

    await realizer.realize({ ...request, intent });

    const userPrompt = send.mock.calls[0][0].input.messages[0].content[0].text;
    for (const needle of mustContain) expect(userPrompt).toContain(needle);
    for (const needle of mustNotContain) expect(userPrompt).not.toContain(needle);
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

    const message = await realizeSupplierResponse(realizer, deterministic);

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
      realizeSupplierResponse(realizer, deterministic),
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
    );

    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("supplier_response_realization");
    expect(logged).toContain('"mode":"bedrock"');
    expect(logged).not.toContain(generated);
    expect(logged).not.toContain("CF-220");
    log.mockRestore();
  });

  it("classifies ValidationException and logs only safe failure metadata", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const deterministic = await service().respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    });
    const sensitiveErrorMessage =
      "Secret error message containing prompt, transcript and generated text";
    const validationError = Object.assign(new Error(sensitiveErrorMessage), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });

    await expect(realizeSupplierResponse(
      { realize: vi.fn().mockRejectedValue(validationError) },
      deterministic,
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
    expect(logged).not.toContain(deterministic.message);
    log.mockRestore();
  });
});
