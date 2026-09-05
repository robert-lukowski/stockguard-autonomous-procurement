import { normalizeText } from "./catalog";
import type { RecognizedRequest } from "./types";

/**
 * Deterministic interpretation of what the judge said.
 *
 * In the deployed runtime these slots arrive from Lex (or an LLM managing the
 * conversation). This parser is the local, telephony-free stand-in AND the
 * server-side validator: whichever layer proposes a quantity or a deadline,
 * the values are re-derived or bounds-checked here before any tool sees them.
 *
 * It deliberately reports `null` rather than guessing. An unparsed field is
 * filled from the mission by the orchestrator, which records the substitution
 * in the audit trail — nothing is silently invented.
 */

const ones: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const tens: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Words that introduce a request but carry no procurement meaning. */
const leadingFiller = new Set([
  "i",
  "we",
  // normalizeText strips apostrophes, so "I'd" arrives as "i d".
  "d",
  "ll",
  "need",
  "want",
  "would",
  "like",
  "please",
  "could",
  "you",
  "can",
  "get",
  "me",
  "us",
  "order",
  "buy",
  "purchase",
  "some",
  "a",
  "an",
  "the",
  "of",
  "for",
  "hi",
  "hello",
  "just",
  "also",
  "looking",
  "to",
]);

/** Units the product query never needs. */
const trailingFiller = new Set(["units", "unit", "pieces", "piece", "pcs", "items", "item"]);

function parseWordNumber(tokens: string[], index: number): { value: number; length: number } | null {
  const first = tokens[index];
  if (first === undefined) return null;

  if (/^\d+$/.test(first)) {
    const value = Number.parseInt(first, 10);
    return Number.isSafeInteger(value) ? { value, length: 1 } : null;
  }

  if (first in tens) {
    const second = tokens[index + 1];
    if (second !== undefined && second in ones && ones[second] > 0 && ones[second] < 10) {
      return { value: tens[first] + ones[second], length: 2 };
    }
    return { value: tens[first], length: 1 };
  }

  if (first in ones) return { value: ones[first], length: 1 };
  return null;
}

/**
 * Finds the first quantity in the utterance.
 *
 * A number immediately followed by a time unit is a deadline, not a quantity
 * ("within seven days"), so those are skipped here and read by
 * `extractDeliveryWindow` instead.
 */
function extractQuantity(tokens: string[]): { value: number; span: [number, number] } | null {
  const timeUnits = new Set(["day", "days", "week", "weeks", "month", "months"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const parsed = parseWordNumber(tokens, index);
    if (!parsed) continue;
    const next = tokens[index + parsed.length];
    if (next !== undefined && timeUnits.has(next)) continue;
    if (index > 0 && (tokens[index - 1] === "within" || tokens[index - 1] === "in")) continue;
    return { value: parsed.value, span: [index, index + parsed.length] };
  }
  return null;
}

/** Recognizes "within a week", "in 7 days", "within two weeks", "by next week". */
function extractDeliveryWindow(
  tokens: string[],
): { days: number; span: [number, number] } | null {
  const multipliers: Record<string, number> = {
    day: 1,
    days: 1,
    week: 7,
    weeks: 7,
    month: 30,
    months: 30,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (!["within", "in", "by", "inside"].includes(tokens[index])) continue;

    let cursor = index + 1;
    let count = 1;
    if (tokens[cursor] === "a" || tokens[cursor] === "the" || tokens[cursor] === "next") {
      cursor += 1;
    } else {
      const parsed = parseWordNumber(tokens, cursor);
      if (parsed) {
        count = parsed.value;
        cursor += parsed.length;
      }
    }

    const unit = tokens[cursor];
    if (unit === undefined || !(unit in multipliers)) continue;
    const days = count * multipliers[unit];
    if (!Number.isSafeInteger(days) || days <= 0) continue;
    return { days, span: [index, cursor + 1] };
  }
  return null;
}

export function interpretUtterance(rawText: string): RecognizedRequest {
  const tokens = normalizeText(rawText).split(" ").filter(Boolean);

  const delivery = extractDeliveryWindow(tokens);
  const quantity = extractQuantity(tokens);

  const consumed = new Set<number>();
  for (const span of [delivery?.span, quantity?.span]) {
    if (!span) continue;
    for (let index = span[0]; index < span[1]; index += 1) consumed.add(index);
  }

  const remaining = tokens.filter((_, index) => !consumed.has(index));
  let start = 0;
  while (start < remaining.length && leadingFiller.has(remaining[start])) start += 1;
  let end = remaining.length;
  while (end > start && trailingFiller.has(remaining[end - 1])) end -= 1;

  return {
    rawText,
    productQuery: remaining.slice(start, end).join(" "),
    quantity: quantity?.value ?? null,
    requiredWithinDays: delivery?.days ?? null,
  };
}
