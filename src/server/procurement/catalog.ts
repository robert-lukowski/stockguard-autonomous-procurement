import type {
  CatalogCategory,
  CatalogItem,
  InventoryMatch,
  InventorySearchResult,
} from "./types";

/**
 * The closed StockGuard catalog.
 *
 * "Closed" is the safety property. Product resolution can only ever return one
 * of these SKUs; there is no fallback that invents a product, and no model is
 * consulted. A query that matches nothing is reported as out of domain, which
 * is what makes the pizza case answerable safely rather than creatively.
 */
export const stockGuardCatalog: CatalogItem[] = [
  {
    sku: "SSD-IND-960",
    name: "Industrial SSD 960GB",
    category: "STORAGE",
    keywords: [
      "industrial ssd",
      "industrial solid state drive",
      "industrial solid state",
      "ssd",
      "solid state drive",
      "industrial drive",
      "nvme drive",
    ],
    minimumOrderQuantity: 1,
    maximumOrderQuantity: 500,
  },
  {
    sku: "NIC-10G-X2",
    name: "10GbE Dual-Port Network Adapter",
    category: "NETWORKING",
    keywords: [
      "network adapter",
      "network card",
      "network interface card",
      "nic",
      "10gbe adapter",
      "ethernet adapter",
    ],
    minimumOrderQuantity: 1,
    maximumOrderQuantity: 200,
  },
  {
    sku: "RAM-ECC-32",
    name: "32GB ECC Server Memory Module",
    category: "COMPUTE",
    keywords: [
      "ecc memory",
      "server memory",
      "memory module",
      "ram module",
      "ecc ram",
      "dimm",
    ],
    minimumOrderQuantity: 2,
    maximumOrderQuantity: 400,
  },
  {
    sku: "UPS-RACK-3K",
    name: "3kVA Rack-Mount UPS",
    category: "POWER",
    keywords: [
      "rack ups",
      "uninterruptible power supply",
      "ups",
      "battery backup",
      "power supply unit",
    ],
    minimumOrderQuantity: 1,
    maximumOrderQuantity: 50,
  },
];

export const supportedCatalogCategories: CatalogCategory[] = [
  "STORAGE",
  "NETWORKING",
  "COMPUTE",
  "POWER",
];

/**
 * Same normalization the CALL-E evidence matcher uses, for the same reason:
 * punctuation, casing and Unicode form must not decide whether a phrase
 * matches.
 */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Light singularization, applied to BOTH sides of a comparison.
 *
 * "twelve network adapters" must reach the keyword "network adapter". Stripping
 * a trailing "s" does that, but only above three characters and never after
 * another "s", so "ups" stays "ups" and "ecc" stays "ecc". This is deliberately
 * not a real stemmer: a closed catalog needs plural tolerance, not linguistics.
 */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

/** Normalized text with every token singularized, for matching only. */
export function matchableText(value: string): string {
  return normalizeText(value).split(" ").filter(Boolean).map(stem).join(" ");
}

export function findCatalogItem(sku: string): CatalogItem | null {
  return stockGuardCatalog.find((item) => item.sku === sku) ?? null;
}

const nameStopWords = new Set([
  "gb",
  "kva",
  "dual",
  "port",
  "mount",
  "module",
  "32",
  "960",
  "10gbe",
  "3kva",
]);

function nameTokens(item: CatalogItem): string[] {
  return matchableText(item.name)
    .split(" ")
    .filter((token) => token.length > 2 && !nameStopWords.has(token));
}

/**
 * Deterministic scoring.
 *
 * A whole keyword phrase found in the query scores its token count, so a
 * specific phrase ("industrial ssd") always outranks an incidental single-word
 * overlap. Name tokens contribute a half point each, enough to break ties but
 * never enough to resolve a product on their own.
 */
function scoreItem(item: CatalogItem, normalizedQuery: string): number {
  const paddedQuery = ` ${normalizedQuery} `;
  let best = 0;
  for (const keyword of item.keywords) {
    const normalizedKeyword = matchableText(keyword);
    if (normalizedKeyword.length === 0) continue;
    if (paddedQuery.includes(` ${normalizedKeyword} `)) {
      best = Math.max(best, normalizedKeyword.split(" ").length);
    }
  }
  if (best === 0) return 0;

  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  const overlap = nameTokens(item).filter((token) => queryTokens.has(token)).length;
  return best + overlap / 2;
}

/**
 * `searchInventory` in tool form.
 *
 * Returns OUT_OF_DOMAIN rather than a best guess when nothing matches, and
 * AMBIGUOUS rather than picking a winner when two SKUs tie. Neither is an
 * error: both are correct, and both are answers the conversational layer is
 * allowed to read out.
 */
export function searchCatalog(
  query: string,
  allowedCategories: CatalogCategory[] = supportedCatalogCategories,
): InventorySearchResult {
  const normalizedQuery = matchableText(query);
  const allowed = new Set(allowedCategories);

  const scored: InventoryMatch[] = stockGuardCatalog
    .filter((item) => allowed.has(item.category))
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      category: item.category,
      score: scoreItem(item, normalizedQuery),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.sku.localeCompare(right.sku));

  if (normalizedQuery.length === 0 || scored.length === 0) {
    return {
      status: "OUT_OF_DOMAIN",
      query: normalizedQuery,
      matches: [],
      supportedCategories: [...allowedCategories],
    };
  }

  const ambiguous = scored.length > 1 && scored[0].score === scored[1].score;
  return {
    status: ambiguous ? "AMBIGUOUS" : "RESOLVED",
    query: normalizedQuery,
    matches: ambiguous ? scored.filter((match) => match.score === scored[0].score) : [scored[0]],
    supportedCategories: [...allowedCategories],
  };
}
