import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  SupplierResponseRealizationRequest,
  SupplierResponseRealizer,
} from "./SupplierResponseRealizer";

// Deliberately short. The realizer receives the deterministic facts as JSON
// and speaks one sentence built from them; the previous 11-rule prompt was a
// list of past mistakes rather than instructions the model needed. The
// caller's utterance is no longer passed in at all (see userMessage below),
// which also removes the prompt-injection surface that the previous rule
// about "conversational context only" was trying to defuse.
export const BEDROCK_SUPPLIER_SYSTEM_PROMPT = [
  "You speak in one short sentence as a sales rep at a supplier's desk, answering a procurement caller by phone.",
  "Use only the facts in the JSON below. Do not add numbers, dates, or terms that are not there.",
  "If commercialTermsChanged is true, mention it plainly and briefly.",
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
  // Only the deterministic facts reach the model. The caller's utterance is
  // deliberately omitted: the intent already tells the model what to answer,
  // and passing raw caller text is an unnecessary prompt-injection surface.
  return JSON.stringify(request);
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
            // 0.4 gives the model enough room to build a natural sentence
            // from the facts without drifting off them. 80 tokens is the
            // discipline that keeps the sentence one line long.
            temperature: 0.4,
            maxTokens: 80,
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
