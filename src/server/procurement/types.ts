import type { Currency, PolicyCheck, ValidationResult } from "../../domain";

/**
 * Channel-independent procurement contracts.
 *
 * Nothing in this module knows whether the request arrived by voice, chat,
 * HTTP or a future Amazon Connect WebRTC contact. A channel supplies text and
 * renders results; every decision, every fact and every state change is made
 * here, server-side.
 *
 * The conversational layer (Lex, an LLM narrator, a human typing in the Judge
 * Portal) is deliberately NOT trusted with facts. It may only pass identifiers
 * and free text into the tool boundary below; catalog membership, prices,
 * availability, policy outcomes and purchase creation are decided from
 * deterministic data on this side of that boundary.
 */

/** Categories the StockGuard catalog covers. Anything else is out of domain. */
export type CatalogCategory = "STORAGE" | "NETWORKING" | "COMPUTE" | "POWER";

export const catalogCategoryLabels: Record<CatalogCategory, string> = {
  STORAGE: "industrial storage",
  NETWORKING: "networking hardware",
  COMPUTE: "server compute and memory",
  POWER: "rack power and UPS",
};

export type CatalogItem = {
  sku: string;
  name: string;
  category: CatalogCategory;
  /**
   * Deterministic resolution vocabulary.
   *
   * These are the ONLY phrases that can resolve to this SKU. A model cannot
   * widen them, and an unmatched query is reported as out of domain rather
   * than guessed at.
   */
  keywords: string[];
  minimumOrderQuantity: number;
  maximumOrderQuantity: number;
};

/** A small, bounded procurement task presented to the judge. */
export type JudgeMission = {
  missionId: string;
  title: string;
  productLabel: string;
  allowedCategories: CatalogCategory[];
  requestedQuantity: number;
  maximumBudget: number;
  budgetCurrency: Currency;
  requiredDeliveryDays: number;
  exampleUtterance: string;
};

/** What the interpreter believes was asked. Never authoritative on its own. */
export type RecognizedRequest = {
  rawText: string;
  productQuery: string;
  quantity: number | null;
  requiredWithinDays: number | null;
};

/**
 * The recognized request after mission defaults have been applied.
 *
 * `assumed` records every field the judge did not actually say, so the portal
 * and the audit trail can show what was inferred rather than heard.
 */
export type ResolvedRequest = {
  productQuery: string;
  quantity: number;
  requiredWithinDays: number;
  assumed: Array<"quantity" | "requiredWithinDays">;
};

export type ToolName =
  | "searchInventory"
  | "getSupplierQuote"
  | "evaluatePurchase"
  | "createPurchaseRequest"
  | "requestHumanApproval";

export type ToolErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "EMPTY_QUERY"
  | "SKU_NOT_IN_CATALOG"
  | "CATEGORY_NOT_ALLOWED"
  | "QUANTITY_OUT_OF_RANGE"
  | "SUPPLIER_TOOL_UNAVAILABLE"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_PROVENANCE_INVALID"
  | "QUOTE_EXPIRED"
  | "EVALUATION_NOT_FOUND"
  | "EVALUATION_QUOTE_MISMATCH"
  | "NOT_APPROVED_BY_POLICY"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_INVALID"
  | "HUMAN_APPROVAL_NOT_REQUIRED";

export type ToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ToolErrorCode; message: string };

export type InventoryMatch = {
  sku: string;
  name: string;
  category: CatalogCategory;
  score: number;
};

/**
 * `OUT_OF_DOMAIN` is a successful tool call, not a tool error.
 *
 * Refusing a request the catalog does not cover is correct behaviour, and
 * counting it as a failure would make the tool-error metric useless as a
 * health signal.
 */
export type InventorySearchResult = {
  status: "RESOLVED" | "AMBIGUOUS" | "OUT_OF_DOMAIN";
  query: string;
  matches: InventoryMatch[];
  supportedCategories: CatalogCategory[];
};

/**
 * A quote produced by the Supplier Tool.
 *
 * `provenanceHash` is the control that stops a conversational layer from
 * inventing or editing a quote: every later state-changing tool re-derives
 * this hash from the server-side record and refuses anything that does not
 * match. The hash covers the commercial substance, the issuing session and
 * the issuing time.
 */
export type SupplierQuote = {
  quoteId: string;
  sessionId: string;
  sku: string;
  quantity: number;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  currency: Currency;
  availableQuantity: number;
  deliveryAt: string;
  offerValidUntil: string;
  commercialTermsChanged: boolean;
  commercialTermsSummary: string;
  issuedAt: string;
  expiresAt: string;
  datasetVersion: string;
  provenance: "SUPPLIER_TOOL";
  provenanceHash: string;
};

export type EvaluationOutcome = "ACCEPTED" | "REJECTED" | "HUMAN_REVIEW_REQUIRED";

export type PurchaseEvaluation = {
  evaluationId: string;
  sessionId: string;
  quoteId: string;
  quoteProvenanceHash: string;
  outcome: EvaluationOutcome;
  /** The existing evidence-aware Policy Gateway result, unchanged. */
  coreValidation: ValidationResult;
  /** Mission-scoped checks (budget, delivery window, quantity), same shape. */
  missionChecks: PolicyCheck[];
  /** Core checks followed by mission checks, for a single uniform trace. */
  checks: PolicyCheck[];
  orderTotal: number;
  orderCurrency: Currency;
  explanation: string;
  blockingCheckIds: string[];
  humanReviewCheckIds: string[];
  confirmationRequired: boolean;
  /**
   * Single-use token issued only for an ACCEPTED evaluation.
   *
   * `createPurchaseRequest` will not act without it, so a conversational layer
   * cannot manufacture consent by claiming the judge agreed.
   */
  confirmationToken: string | null;
  evaluatedAt: string;
};

export type PurchaseRequest = {
  purchaseRequestId: string;
  sessionId: string;
  quoteId: string;
  evaluationId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  currency: Currency;
  totalPrice: number;
  supplierId: string;
  supplierName: string;
  deliveryAt: string;
  createdAt: string;
  status: "CREATED";
  synthetic: true;
};

export type PurchaseRequestResult = {
  request: PurchaseRequest;
  /** True when an already-consumed confirmation token was replayed. */
  replayed: boolean;
};

export type HumanApprovalRequest = {
  approvalRequestId: string;
  sessionId: string;
  quoteId: string;
  evaluationId: string;
  reasonCheckIds: string[];
  createdAt: string;
  status: "PENDING_HUMAN_APPROVAL";
  /** Structural, not aspirational: this path never creates an order... */
  orderCreated: false;
  /** ...and never edits policy. */
  policyChanged: false;
};

export type RunOutcome =
  | "PURCHASE_REQUEST_CREATED"
  | "REJECTED_BY_POLICY"
  | "HUMAN_APPROVAL_REQUESTED"
  | "OUT_OF_DOMAIN"
  | "DECLINED_BY_USER"
  | "TOOL_FAILURE";
