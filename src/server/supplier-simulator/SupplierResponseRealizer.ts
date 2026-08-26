import type {
  SupplierSimulatorResponse,
  SupplierSimulatorIntent,
} from "./types";

export type SupplierResponseRealizationRequest = {
  intent: SupplierSimulatorIntent;
  supplierName: string;
  sku: string;
  requestedQuantity: number;
  availableQuantity: number;
  unitPrice: number;
  currency: string;
  deliveryAt: string;
  offerValidUntil: string;
  commercialTermsChanged: boolean;
  commercialTermsSummary: string;
};

export interface SupplierResponseRealizer {
  realize(request: SupplierResponseRealizationRequest): Promise<string>;
}

function realizationRequest(
  result: SupplierSimulatorResponse,
): SupplierResponseRealizationRequest {
  return {
    intent: result.intent,
    supplierName: result.quote.supplierName,
    sku: result.quote.sku,
    requestedQuantity: result.quote.requestedQuantity,
    availableQuantity: result.quote.availableQuantity,
    unitPrice: result.quote.unitPrice,
    currency: result.quote.currency,
    deliveryAt: result.quote.deliveryAt,
    offerValidUntil: result.quote.offerValidUntil,
    commercialTermsChanged: result.quote.commercialTermsChanged,
    commercialTermsSummary: result.quote.commercialTermsSummary,
  };
}

function failureCategory(error: unknown): string {
  const name = errorName(error);
  const message = error instanceof Error ? error.message : "";
  const detail = `${name} ${message}`.toLowerCase();

  if (detail.includes("validationexception")) return "validation-error";
  if (detail.includes("timeout") || detail.includes("abort")) return "timeout";
  if (detail.includes("accessdenied")) return "access-denied";
  if (detail.includes("throttl")) return "throttled";
  if (detail.includes("empty") || detail.includes("malformed")) {
    return "invalid-response";
  }
  return "service-error";
}

function errorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name.trim().length > 0
  ) {
    return error.name;
  }
  return "UnknownError";
}

function httpStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
}

export async function realizeSupplierResponse(
  realizer: SupplierResponseRealizer,
  result: SupplierSimulatorResponse,
): Promise<string> {
  const startedAt = Date.now();

  try {
    const message = await realizer.realize(realizationRequest(result));
    if (typeof message !== "string" || message.trim().length === 0) {
      const emptyResponse = new Error("BEDROCK_EMPTY_RESPONSE");
      emptyResponse.name = "BedrockEmptyResponseError";
      throw emptyResponse;
    }

    console.log(JSON.stringify({
      event: "supplier_response_realization",
      intent: result.intent,
      mode: "bedrock",
      elapsedMs: Date.now() - startedAt,
    }));
    return message.trim();
  } catch (error) {
    const statusCode = httpStatusCode(error);
    console.log(JSON.stringify({
      event: "supplier_response_realization",
      intent: result.intent,
      mode: "deterministic-fallback",
      failureCategory: failureCategory(error),
      errorName: errorName(error),
      ...(statusCode === undefined ? {} : { httpStatusCode: statusCode }),
      elapsedMs: Date.now() - startedAt,
    }));
    return result.message;
  }
}
