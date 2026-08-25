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
  latestCallerQuestion: string;
};

export interface SupplierResponseRealizer {
  realize(request: SupplierResponseRealizationRequest): Promise<string>;
}

function realizationRequest(
  result: SupplierSimulatorResponse,
  latestCallerQuestion: string | undefined,
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
    latestCallerQuestion: latestCallerQuestion?.trim() ?? "",
  };
}

function failureCategory(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const detail = `${name} ${message}`.toLowerCase();

  if (detail.includes("timeout") || detail.includes("abort")) return "timeout";
  if (detail.includes("accessdenied")) return "access-denied";
  if (detail.includes("throttl")) return "throttled";
  if (detail.includes("empty") || detail.includes("malformed")) {
    return "invalid-response";
  }
  return "service-error";
}

export async function realizeSupplierResponse(
  realizer: SupplierResponseRealizer,
  result: SupplierSimulatorResponse,
  latestCallerQuestion: string | undefined,
): Promise<string> {
  const startedAt = Date.now();

  try {
    const message = await realizer.realize(
      realizationRequest(result, latestCallerQuestion),
    );
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new Error("BEDROCK_EMPTY_RESPONSE");
    }

    console.log(JSON.stringify({
      event: "supplier_response_realization",
      intent: result.intent,
      mode: "bedrock",
      elapsedMs: Date.now() - startedAt,
    }));
    return message.trim();
  } catch (error) {
    console.log(JSON.stringify({
      event: "supplier_response_realization",
      intent: result.intent,
      mode: "deterministic-fallback",
      elapsedMs: Date.now() - startedAt,
      failureCategory: failureCategory(error),
    }));
    return result.message;
  }
}
