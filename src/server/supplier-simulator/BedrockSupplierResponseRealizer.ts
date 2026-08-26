import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  SupplierResponseRealizationRequest,
  SupplierResponseRealizer,
} from "./SupplierResponseRealizer";

export const BEDROCK_SUPPLIER_SYSTEM_PROMPT = [
  "You are a supplier sales representative speaking naturally by phone.",
  "Use only the supplier data provided below. Do not invent, estimate, assume, or change any facts.",
  "Answer all parts of the caller's latest question that are supported by the data, using the full conversation for context, but do not volunteer unrelated facts.",
  "Keep every reply to one concise spoken sentence, ideally under 35 words.",
  "Do not use greetings, acknowledgements, headings, labels, bullet-style lists, or filler unless the caller explicitly asks for them.",
  "Do not repeat facts already confirmed unless they are needed to answer the latest question.",
  "If the data does not contain an answer, say that you cannot confirm it.",
].join(" ");

export type BedrockConverseClient = {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
};

type BedrockSupplierResponseRealizerConfig = {
  modelId: string;
  timeoutMs: number;
  region?: string;
  client?: BedrockConverseClient;
};

function userMessage(request: SupplierResponseRealizationRequest): string {
  return JSON.stringify({
    conversation: request.conversation,
    supplierData: {
      supplierName: request.supplierName,
      sku: request.sku,
      requestedQuantity: request.requestedQuantity,
      availableQuantity: request.availableQuantity,
      unitPrice: request.unitPrice,
      currency: request.currency,
      deliveryAt: request.deliveryAt,
      offerValidUntil: request.offerValidUntil,
      commercialTermsChanged: request.commercialTermsChanged,
      commercialTermsSummary: request.commercialTermsSummary,
    },
  });
}

export class BedrockSupplierResponseRealizer
  implements SupplierResponseRealizer
{
  private readonly client: BedrockConverseClient;
  private readonly modelId: string;
  private readonly timeoutMs: number;

  constructor(config: BedrockSupplierResponseRealizerConfig) {
    if (config.modelId.trim().length === 0) {
      throw new Error("Bedrock supplier model id is required");
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("Bedrock supplier timeout must be positive");
    }

    this.modelId = config.modelId;
    this.timeoutMs = config.timeoutMs;
    this.client = config.client ?? new BedrockRuntimeClient({
      region: config.region ?? "eu-central-1",
      maxAttempts: 1,
    });
  }

  async realize(request: SupplierResponseRealizationRequest): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: BEDROCK_SUPPLIER_SYSTEM_PROMPT }],
          messages: [{
            role: "user",
            content: [{ text: userMessage(request) }],
          }],
          inferenceConfig: {
            temperature: 0.4,
            maxTokens: 160,
          },
        }),
        { abortSignal: controller.signal },
      );

      const content = response.output?.message?.content ?? [];
      const message = content
        .map((block) => "text" in block ? block.text : undefined)
        .filter((text): text is string => typeof text === "string")
        .join(" ")
        .trim();
      if (message.length === 0) {
        const emptyResponse = new Error("BEDROCK_EMPTY_RESPONSE");
        emptyResponse.name = "BedrockEmptyResponseError";
        throw emptyResponse;
      }
      return message;
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error("BEDROCK_TIMEOUT", { cause: error });
        timeoutError.name = "BedrockTimeoutError";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
