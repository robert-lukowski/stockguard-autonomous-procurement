import type { InventorySearchResult, JudgeMission } from "./types";
import { catalogCategoryLabels } from "./types";

/**
 * How the assistant is allowed to speak.
 *
 * The orchestrator decides everything; a narrator only chooses wording. This
 * mirrors `SupplierResponseRealizer`, where Bedrock may vary phrasing but
 * never facts, and it is the mechanism behind "the LLM may manage the
 * conversation but must not invent".
 *
 * Two independent controls enforce that:
 *
 *   1. A narrator receives `NarrationRequest` only. It never sees the catalog,
 *      the supplier store, or the tool boundary, so it has nothing to invent
 *      from.
 *   2. `narrateSafely` rejects any narration containing a figure that is not
 *      in the caller-supplied `allowedFigures`, and falls back to the
 *      deterministic text. A hallucinated price, quantity or date cannot reach
 *      the judge even if a model produces one.
 */
export type NarrationRequest = {
  kind:
    | "MISSION_INTRO"
    | "OUT_OF_DOMAIN"
    | "AMBIGUOUS_PRODUCT"
    | "QUOTE_PRESENTED"
    | "EVALUATION_EXPLAINED"
    | "PURCHASE_CREATED"
    | "HUMAN_APPROVAL"
    | "TOOL_FAILURE";
  deterministicMessage: string;
  /**
   * Every numeric string the narration is permitted to contain.
   *
   * Derived from tool output by the orchestrator, never by the narrator.
   */
  allowedFigures: string[];
  facts: Record<string, string | number | boolean | null>;
};

export interface ConversationNarrator {
  narrate(request: NarrationRequest): Promise<string>;
}

/** The default. No model, no network, no variance. */
export class DeterministicNarrator implements ConversationNarrator {
  async narrate(request: NarrationRequest): Promise<string> {
    return request.deterministicMessage;
  }
}

/** Digits, with thousands separators and decimals kept as one figure. */
export function figuresIn(text: string): string[] {
  return (text.match(/\d[\d.,]*/g) ?? []).map((figure) => figure.replace(/[.,]+$/, ""));
}

function normalizeFigure(figure: string): string {
  const withoutSeparators = figure.replace(/,/g, "");
  const numeric = Number.parseFloat(withoutSeparators);
  if (!Number.isFinite(numeric)) return withoutSeparators;
  // 1960, 1960.0 and 1,960.00 are the same figure.
  return String(numeric);
}

/**
 * True when every figure in `text` appears in `allowed`.
 *
 * Deliberately strict: an unrecognized number is treated as invented, because
 * there is no safe way to tell a harmless rounding from a fabricated price.
 */
export function narrationOnlyUsesKnownFigures(text: string, allowed: string[]): boolean {
  const permitted = new Set(allowed.flatMap((value) => figuresIn(value)).map(normalizeFigure));
  return figuresIn(text).every((figure) => permitted.has(normalizeFigure(figure)));
}

/**
 * Runs a narrator and falls back to the deterministic message on any failure,
 * empty response, or figure the tools did not produce.
 */
export async function narrateSafely(
  narrator: ConversationNarrator,
  request: NarrationRequest,
): Promise<{ message: string; mode: "narrated" | "deterministic-fallback"; reason?: string }> {
  let narrated: string;
  try {
    narrated = await narrator.narrate(request);
  } catch {
    return {
      message: request.deterministicMessage,
      mode: "deterministic-fallback",
      reason: "narrator-error",
    };
  }

  if (typeof narrated !== "string" || narrated.trim().length === 0) {
    return {
      message: request.deterministicMessage,
      mode: "deterministic-fallback",
      reason: "empty-narration",
    };
  }
  if (!narrationOnlyUsesKnownFigures(narrated, [...request.allowedFigures, request.deterministicMessage])) {
    return {
      message: request.deterministicMessage,
      mode: "deterministic-fallback",
      reason: "unknown-figure",
    };
  }
  return { message: narrated.trim(), mode: "narrated" };
}

export function outOfDomainMessage(result: InventorySearchResult, mission: JudgeMission): string {
  const categories = result.supportedCategories
    .map((category) => catalogCategoryLabels[category])
    .join(", ");
  return [
    "I can only source items from the StockGuard industrial IT catalog, so I cannot help with that request.",
    `The catalog covers ${categories}.`,
    `For this mission you can ask for ${mission.productLabel}.`,
  ].join(" ");
}

export function ambiguousProductMessage(result: InventorySearchResult): string {
  const options = result.matches.map((match) => `${match.name} (${match.sku})`).join(" or ");
  return `I found more than one catalog match: ${options}. Which one do you mean?`;
}
