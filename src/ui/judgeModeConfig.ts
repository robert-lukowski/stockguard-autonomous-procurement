import type { SupportedCallLocale } from "../server/calle";

/**
 * Resolves the Live Judge Mode backend URL.
 *
 * Returns null unless a syntactically valid HTTPS URL was supplied at build
 * time. Null means the live panel stays locked and no network request is ever
 * made — the public mock walkthrough is unaffected.
 *
 * A configured URL says only where a backend would be. It is NOT evidence that
 * live CALL-E execution is available: only the runtime the backend itself
 * reports may drive a live label.
 */
export function resolveJudgeBackendUrl(
  raw: string | undefined = import.meta.env?.VITE_JUDGE_BACKEND_URL,
): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  // Plaintext would expose the judge's access code and phone number.
  if (parsed.protocol !== "https:") return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
}

export const supportedJudgeLocales = [
  "en-GB",
  "en-US",
  "de-DE",
  "fr-FR",
  "pl-PL",
] as const satisfies readonly SupportedCallLocale[];

const localeByCallingCode: Array<[string, SupportedCallLocale]> = [
  ["+1", "en-US"],
  ["+44", "en-GB"],
  ["+33", "fr-FR"],
  ["+49", "de-DE"],
  ["+48", "pl-PL"],
];

/**
 * Derives a conversation locale from the E.164 calling code.
 *
 * Never derived from free-form browser input. A judge may override, but only
 * with a locale the backend already allowlists.
 */
export function deriveLocaleFromPhone(
  phoneE164: string,
): SupportedCallLocale | null {
  const trimmed = phoneE164.trim();
  // Longest prefix first so +44 is not shadowed by a shorter code.
  const match = [...localeByCallingCode]
    .sort(([left], [right]) => right.length - left.length)
    .find(([prefix]) => trimmed.startsWith(prefix));
  return match ? match[1] : null;
}

/** The backend applies the authoritative check; this only guards the form. */
export function isSupportedJudgePhone(phoneE164: string): boolean {
  const trimmed = phoneE164.trim();
  return (
    /^\+[1-9]\d{7,14}$/.test(trimmed) && deriveLocaleFromPhone(trimmed) !== null
  );
}
