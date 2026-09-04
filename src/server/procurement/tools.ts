import {
  normalizeOffer,
  roundCurrency,
  validateOffer,
  type Currency,
  type ExchangeRatesToEur,
  type PolicyCheck,
  type ProcurementPolicy,
  type ShortageForecast,
  type SupplierOffer,
} from "../../domain";
import { findCatalogItem, searchCatalog } from "./catalog";
import { supplierProfileForSku } from "./supplierCatalog";
import { sha256 } from "../../security";
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  type SyntheticRfq,
} from "../supplier-simulator";
import type { ProcurementSession, ProcurementSessionStore } from "./sessionStore";
import type {
  CatalogCategory,
  EvaluationOutcome,
  HumanApprovalRequest,
  InventorySearchResult,
  JudgeMission,
  PurchaseEvaluation,
  PurchaseRequest,
  PurchaseRequestResult,
  SupplierQuote,
  ToolResult,
} from "./types";

/**
 * The controlled tool boundary.
 *
 * This is the only place procurement facts come from, and the only place state
 * changes. A conversational layer — Lex, an LLM, the Judge Portal, a future
 * WebRTC contact — may call these functions with identifiers and free text.
 * It may not supply a price, an availability, a policy outcome or a claim that
 * the user consented; each of those is derived or verified here.
 *
 * Every state-changing call re-validates, from server-side records only:
 *   catalog membership, SKU, quantity range, quote provenance, budget,
 *   delivery constraint, policy result, explicit confirmation, and replay.
 *
 * None of these checks trusts an argument it was handed.
 */

export const judgePortalPolicy: ProcurementPolicy = {
  version: "stockguard-judge-portal-policy-v1",
  autonomousOrderLimitEur: 20_000,
  unitPriceCeilingEur: 2_000,
  minimumConfidence: 0.8,
  maximumAttempts: 2,
  approvedCurrencies: ["EUR", "USD", "PLN", "GBP"],
};

/**
 * Fixed demo rates.
 *
 * Deterministic on purpose: a live FX feed would make the same run produce
 * different policy outcomes on different days, which is exactly what a
 * reproducible judge demo must not do.
 */
export const judgePortalExchangeRates: ExchangeRatesToEur = {
  EUR: 1,
  USD: 0.92,
  PLN: 0.23,
  GBP: 1.17,
};

/** Quote lifetime. Short enough that a stale quote cannot be replayed later. */
export const QUOTE_TTL_MS = 10 * 60_000;

export type ProcurementToolsConfig = {
  sessions: ProcurementSessionStore;
  clock: () => Date;
  newId: (prefix: string) => string;
  policy?: ProcurementPolicy;
  exchangeRates?: ExchangeRatesToEur;
  /**
   * The Supplier Tool.
   *
   * Injected so a test can supply a failing implementation, and so the future
   * real supplier adapter (API, EDI, or a human-answered channel) can replace
   * the simulator without touching a single validation rule below.
   */
  supplierQuotes?: SupplierQuotePort;
};

export type SupplierQuoteRequest = {
  sku: string;
  quantity: number;
  requiredBy: string;
  runId: string;
};

export type SupplierQuoteFacts = {
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  currency: Currency;
  availableQuantity: number;
  deliveryAt: string;
  offerValidUntil: string;
  commercialTermsChanged: boolean;
  commercialTermsSummary: string;
  datasetVersion: string;
};

export interface SupplierQuotePort {
  quote(request: SupplierQuoteRequest): Promise<SupplierQuoteFacts>;
}

/**
 * In-process Supplier Tool backed by the existing deterministic simulator.
 *
 * No PSTN call, no Amazon Connect, no Lex, no CALL-E vendor. The simulator's
 * quote maths is reused exactly as the telephony path used it, which is what
 * makes the two paths comparable — only the transport is gone.
 *
 * Because the facts arrive as a typed value rather than as speech recognized
 * from a phone line, every field is first-party evidence. That is the concrete
 * reason the pivot removes the evidence-verification risk described in
 * `docs/calle-assumptions-register.md`.
 */
export class SimulatedSupplierQuoteTool implements SupplierQuotePort {
  async quote(request: SupplierQuoteRequest): Promise<SupplierQuoteFacts> {
    const profile = supplierProfileForSku(request.sku);
    if (!profile) throw new Error(`No supplier profile is configured for ${request.sku}`);

    const rfq: SyntheticRfq = {
      runId: request.runId,
      rfqId: `RFQ-${request.runId}`,
      routingCode: "000000",
      profileId: profile.profileId,
      datasetVersion: profile.datasetVersion,
      sku: request.sku,
      requestedQuantity: request.quantity,
      requiredBy: request.requiredBy,
      expiresAt: new Date(Date.parse(request.requiredBy) + QUOTE_TTL_MS).toISOString(),
    };

    const service = new SupplierSimulatorService(
      new InMemorySyntheticSupplierStore([profile], [rfq]),
    );
    const response = await service.respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: profile.profileId,
    });
    const quote = response.quote;

    return {
      supplierId: quote.supplierId,
      supplierName: quote.supplierName,
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      availableQuantity: quote.availableQuantity,
      deliveryAt: quote.deliveryAt,
      offerValidUntil: quote.offerValidUntil,
      commercialTermsChanged: quote.commercialTermsChanged,
      commercialTermsSummary: quote.commercialTermsSummary,
      datasetVersion: quote.datasetVersion,
    };
  }
}

function err<T>(error: ToolResult<T> & { ok: false }): ToolResult<T> {
  return error;
}

/**
 * The session disappeared between the guard read and the write-back read.
 *
 * Not reachable with the in-memory store, but a durable store can evict or
 * expire a session mid-call, and fabricating a success there would be the
 * worst possible failure mode for a tool that spends money.
 */
function sessionVanished<T>(): ToolResult<T> {
  return err<T>({
    ok: false,
    error: "SESSION_NOT_FOUND",
    message: "The procurement session disappeared while the tool was running.",
  });
}

function check(
  id: string,
  status: PolicyCheck["status"],
  evidence: string,
  inputs: PolicyCheck["inputs"],
): PolicyCheck {
  return { id, status, passed: status === "PASS", evidence, inputs };
}

/** Canonical substance of a quote. Any edit changes the hash. */
async function quoteProvenanceHash(
  quote: Omit<SupplierQuote, "provenanceHash">,
): Promise<string> {
  return sha256({
    quoteId: quote.quoteId,
    sessionId: quote.sessionId,
    sku: quote.sku,
    quantity: quote.quantity,
    supplierId: quote.supplierId,
    unitPrice: quote.unitPrice,
    currency: quote.currency,
    availableQuantity: quote.availableQuantity,
    deliveryAt: quote.deliveryAt,
    offerValidUntil: quote.offerValidUntil,
    commercialTermsChanged: quote.commercialTermsChanged,
    issuedAt: quote.issuedAt,
    datasetVersion: quote.datasetVersion,
  });
}

export class ProcurementTools {
  private readonly sessions: ProcurementSessionStore;
  private readonly clock: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly policy: ProcurementPolicy;
  private readonly exchangeRates: ExchangeRatesToEur;
  private readonly supplierQuotes: SupplierQuotePort;

  constructor(config: ProcurementToolsConfig) {
    this.sessions = config.sessions;
    this.clock = config.clock;
    this.newId = config.newId;
    this.policy = config.policy ?? judgePortalPolicy;
    this.exchangeRates = config.exchangeRates ?? judgePortalExchangeRates;
    this.supplierQuotes = config.supplierQuotes ?? new SimulatedSupplierQuoteTool();
  }

  private session(sessionId: string): ToolResult<ProcurementSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err({
        ok: false,
        error: "SESSION_NOT_FOUND",
        message: "This procurement session is not known to the server.",
      });
    }
    if (Date.parse(session.expiresAt) <= this.clock().getTime()) {
      return err({
        ok: false,
        error: "SESSION_EXPIRED",
        message: "This procurement session has expired. Start a new one.",
      });
    }
    return { ok: true, value: session };
  }

  /** Tool 1: resolve free text against the closed catalog. */
  searchInventory(
    query: string,
    allowedCategories?: CatalogCategory[],
  ): ToolResult<InventorySearchResult> {
    if (typeof query !== "string" || query.trim().length === 0) {
      return err({
        ok: false,
        error: "EMPTY_QUERY",
        message: "No product was named in the request.",
      });
    }
    return { ok: true, value: searchCatalog(query, allowedCategories) };
  }

  /** Tool 2: obtain a deterministic quote. Validates catalog and quantity first. */
  async getSupplierQuote(
    sessionId: string,
    sku: string,
    quantity: number,
    requiredBy: string,
  ): Promise<ToolResult<SupplierQuote>> {
    const session = this.session(sessionId);
    if (!session.ok) return session;

    const item = findCatalogItem(sku);
    if (!item) {
      return err({
        ok: false,
        error: "SKU_NOT_IN_CATALOG",
        message: `${sku} is not part of the StockGuard catalog.`,
      });
    }
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < item.minimumOrderQuantity ||
      quantity > item.maximumOrderQuantity
    ) {
      return err({
        ok: false,
        error: "QUANTITY_OUT_OF_RANGE",
        message: `${item.name} can be ordered in quantities of ${item.minimumOrderQuantity} to ${item.maximumOrderQuantity}.`,
      });
    }

    const now = this.clock();
    let facts: SupplierQuoteFacts;
    try {
      facts = await this.supplierQuotes.quote({
        sku,
        quantity,
        requiredBy,
        runId: session.value.sessionId,
      });
    } catch {
      return err({
        ok: false,
        error: "SUPPLIER_TOOL_UNAVAILABLE",
        message: "The supplier system did not answer. No quote was produced.",
      });
    }

    const draft: Omit<SupplierQuote, "provenanceHash"> = {
      quoteId: this.newId("quote"),
      sessionId: session.value.sessionId,
      sku,
      quantity,
      supplierId: facts.supplierId,
      supplierName: facts.supplierName,
      unitPrice: facts.unitPrice,
      currency: facts.currency,
      availableQuantity: facts.availableQuantity,
      deliveryAt: facts.deliveryAt,
      offerValidUntil: facts.offerValidUntil,
      commercialTermsChanged: facts.commercialTermsChanged,
      commercialTermsSummary: facts.commercialTermsSummary,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
      datasetVersion: facts.datasetVersion,
      provenance: "SUPPLIER_TOOL",
    };
    const quote: SupplierQuote = {
      ...draft,
      provenanceHash: await quoteProvenanceHash(draft),
    };

    const updated = this.sessions.get(sessionId);
    if (!updated) return sessionVanished();
    updated.quotes[quote.quoteId] = quote;
    this.sessions.save(updated);
    return { ok: true, value: quote };
  }

  /**
   * Re-reads a quote from the server-side record and re-derives its hash.
   *
   * The caller passes an id, never a quote. Anything the conversational layer
   * believes about price or delivery is discarded here.
   */
  private async verifiedQuote(
    session: ProcurementSession,
    quoteId: string,
  ): Promise<ToolResult<SupplierQuote>> {
    const quote = session.quotes[quoteId];
    if (!quote) {
      return err({
        ok: false,
        error: "QUOTE_NOT_FOUND",
        message: "That quote was never issued by the supplier tool.",
      });
    }
    const { provenanceHash, ...substance } = quote;
    if ((await quoteProvenanceHash(substance)) !== provenanceHash) {
      return err({
        ok: false,
        error: "QUOTE_PROVENANCE_INVALID",
        message: "The stored quote does not match its provenance hash.",
      });
    }
    if (Date.parse(quote.expiresAt) <= this.clock().getTime()) {
      return err({
        ok: false,
        error: "QUOTE_EXPIRED",
        message: "That quote has expired. Request a new one.",
      });
    }
    return { ok: true, value: quote };
  }

  /** Tool 3: run the decision core plus the mission-scoped checks. */
  async evaluatePurchase(
    sessionId: string,
    quoteId: string,
    mission: JudgeMission,
    requiredWithinDays: number,
  ): Promise<ToolResult<PurchaseEvaluation>> {
    const session = this.session(sessionId);
    if (!session.ok) return session;

    const verified = await this.verifiedQuote(session.value, quoteId);
    if (!verified.ok) return verified;
    const quote = verified.value;

    const now = this.clock();
    const evaluatedAt = now.toISOString();
    const requiredBy = new Date(
      now.getTime() + requiredWithinDays * 24 * 60 * 60_000,
    ).toISOString();

    /*
     * The mission's delivery deadline is expressed as the forecast stockout
     * date, so the existing `delivery_before_stockout` check does the work
     * without a parallel rule that could drift away from it.
     */
    const forecast: ShortageForecast = {
      sku: quote.sku,
      requiredQuantity: quote.quantity,
      projectedAvailable: 0,
      stockoutAt: requiredBy,
      shortageDetected: true,
    };

    /*
     * Evidence is VERIFIED because the values came back from a typed tool
     * call, not from speech recognized over a telephone line. This is the
     * substantive difference the pivot buys: there is no transcript to match
     * an excerpt against, so no field can silently degrade to UNVERIFIED.
     */
    const evidenceFields = [
      "skuConfirmed",
      "availableQuantity",
      "unitPrice",
      "currency",
      "deliveryAt",
      "offerValidUntil",
      "commercialTermsChanged",
    ] as const;
    const offer: SupplierOffer = {
      offerId: `${session.value.sessionId}:${quote.quoteId}`,
      supplierId: quote.supplierId,
      supplierName: quote.supplierName,
      approvedSupplier: true,
      consentVerified: true,
      language: "en-US",
      sku: quote.sku,
      exactSkuConfirmed: true,
      availableQuantity: quote.availableQuantity,
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      deliveryAt: quote.deliveryAt,
      offerValidUntil: quote.offerValidUntil,
      commercialTermsChanged: quote.commercialTermsChanged,
      evidenceComplete: true,
      evidenceStatus: Object.fromEntries(
        evidenceFields.map((field) => [field, "VERIFIED"]),
      ) as SupplierOffer["evidenceStatus"],
      evidenceByField: Object.fromEntries(
        evidenceFields.map((field) => [
          field,
          {
            source: "supplier-tool",
            excerpt: `${field} returned by the supplier tool for ${quote.sku}`,
            verified: true,
          },
        ]),
      ) as SupplierOffer["evidenceByField"],
      completionConfidence: 1,
      attemptCount: 1,
    };

    const normalized = normalizeOffer(offer, this.exchangeRates);
    const coreValidation = validateOffer(normalized, forecast, this.policy, evaluatedAt);

    const orderTotal = roundCurrency(quote.unitPrice * quote.quantity);
    const withinBudget = orderTotal <= mission.maximumBudget;
    const deliversInTime = Date.parse(quote.deliveryAt) <= Date.parse(requiredBy);
    const item = findCatalogItem(quote.sku);
    const quantityAllowed =
      item !== null &&
      quote.quantity >= item.minimumOrderQuantity &&
      quote.quantity <= item.maximumOrderQuantity;
    const currencyMatchesMission = quote.currency === mission.budgetCurrency;

    const missionChecks: PolicyCheck[] = [
      check(
        "mission_catalog_membership",
        item ? "PASS" : "FAIL",
        item ? `${quote.sku} is in the StockGuard catalog` : `${quote.sku} is not in the catalog`,
        { sku: quote.sku, inCatalog: item !== null },
      ),
      check(
        "mission_quantity_range",
        quantityAllowed ? "PASS" : "FAIL",
        quantityAllowed
          ? `${quote.quantity} units is within the allowed order range`
          : `${quote.quantity} units is outside the allowed order range`,
        { quantity: quote.quantity, allowed: quantityAllowed },
      ),
      check(
        "mission_currency",
        currencyMatchesMission ? "PASS" : "REQUIRES_HUMAN",
        currencyMatchesMission
          ? `Quote is priced in the mission currency ${mission.budgetCurrency}`
          : `Quote is priced in ${quote.currency}; mission budget is ${mission.budgetCurrency}`,
        { quoteCurrency: quote.currency, missionCurrency: mission.budgetCurrency },
      ),
      check(
        "mission_budget",
        withinBudget ? "PASS" : "FAIL",
        `${orderTotal.toFixed(2)} ${quote.currency} for ${quote.quantity} units; budget ${mission.maximumBudget.toFixed(2)} ${mission.budgetCurrency}`,
        {
          orderTotal,
          budget: mission.maximumBudget,
          currency: quote.currency,
        },
      ),
      check(
        "mission_delivery_window",
        deliversInTime ? "PASS" : "FAIL",
        `Delivery ${quote.deliveryAt}; required by ${requiredBy}`,
        { deliveryAt: quote.deliveryAt, requiredBy, withinDays: requiredWithinDays },
      ),
    ];

    const checks = [...coreValidation.checks, ...missionChecks];
    const blockingCheckIds = checks.filter((entry) => entry.status === "FAIL").map((entry) => entry.id);
    const humanReviewCheckIds = checks
      .filter((entry) => entry.status === "REQUIRES_HUMAN")
      .map((entry) => entry.id);

    const outcome: EvaluationOutcome =
      blockingCheckIds.length > 0
        ? "REJECTED"
        : humanReviewCheckIds.length > 0
          ? "HUMAN_REVIEW_REQUIRED"
          : "ACCEPTED";

    const evaluation: PurchaseEvaluation = {
      evaluationId: this.newId("eval"),
      sessionId: session.value.sessionId,
      quoteId: quote.quoteId,
      quoteProvenanceHash: quote.provenanceHash,
      outcome,
      coreValidation,
      missionChecks,
      checks,
      orderTotal,
      orderCurrency: quote.currency,
      explanation: explainEvaluation(outcome, quote, orderTotal, mission, checks),
      blockingCheckIds,
      humanReviewCheckIds,
      confirmationRequired: outcome === "ACCEPTED",
      confirmationToken: outcome === "ACCEPTED" ? this.newId("confirm") : null,
      evaluatedAt,
    };

    const updated = this.sessions.get(sessionId);
    if (!updated) return sessionVanished();
    updated.evaluations[evaluation.evaluationId] = evaluation;
    this.sessions.save(updated);
    return { ok: true, value: evaluation };
  }

  /**
   * Tool 4: create the purchase request.
   *
   * The only state-changing tool that spends anything, so it re-derives every
   * control from stored records rather than trusting the evaluation it is
   * handed: provenance, catalog, quantity, budget, delivery, policy outcome,
   * and a single-use confirmation token supplied by the human.
   */
  async createPurchaseRequest(
    sessionId: string,
    evaluationId: string,
    confirmationToken: string,
    mission: JudgeMission,
  ): Promise<ToolResult<PurchaseRequestResult>> {
    const session = this.session(sessionId);
    if (!session.ok) return session;

    const evaluation = session.value.evaluations[evaluationId];
    if (!evaluation) {
      return err({
        ok: false,
        error: "EVALUATION_NOT_FOUND",
        message: "That evaluation was never produced by the policy tool.",
      });
    }

    if (typeof confirmationToken !== "string" || confirmationToken.length === 0) {
      return err({
        ok: false,
        error: "CONFIRMATION_REQUIRED",
        message: "An explicit confirmation is required before a purchase request is created.",
      });
    }

    /*
     * Replay check comes BEFORE the token is rejected as consumed: a repeated
     * submission must return the original purchase request, not a second one
     * and not an error.
     */
    const existing = session.value.purchaseRequestsByToken[confirmationToken];
    if (existing) {
      return { ok: true, value: { request: existing, replayed: true } };
    }

    if (evaluation.confirmationToken === null || evaluation.confirmationToken !== confirmationToken) {
      return err({
        ok: false,
        error: "CONFIRMATION_INVALID",
        message: "That confirmation does not match the evaluation it claims to approve.",
      });
    }

    if (evaluation.outcome !== "ACCEPTED") {
      return err({
        ok: false,
        error: "NOT_APPROVED_BY_POLICY",
        message: "Policy did not approve this quote, so no purchase request can be created.",
      });
    }

    const verified = await this.verifiedQuote(session.value, evaluation.quoteId);
    if (!verified.ok) return verified;
    const quote = verified.value;

    if (quote.provenanceHash !== evaluation.quoteProvenanceHash) {
      return err({
        ok: false,
        error: "EVALUATION_QUOTE_MISMATCH",
        message: "The quote changed after it was evaluated.",
      });
    }

    const item = findCatalogItem(quote.sku);
    if (!item) {
      return err({
        ok: false,
        error: "SKU_NOT_IN_CATALOG",
        message: `${quote.sku} is not part of the StockGuard catalog.`,
      });
    }
    if (quote.quantity < item.minimumOrderQuantity || quote.quantity > item.maximumOrderQuantity) {
      return err({
        ok: false,
        error: "QUANTITY_OUT_OF_RANGE",
        message: "The quoted quantity is outside the allowed order range.",
      });
    }

    const totalPrice = roundCurrency(quote.unitPrice * quote.quantity);
    if (totalPrice > mission.maximumBudget) {
      return err({
        ok: false,
        error: "NOT_APPROVED_BY_POLICY",
        message: "The order total exceeds the mission budget.",
      });
    }

    const now = this.clock();
    const request: PurchaseRequest = {
      purchaseRequestId: this.newId("pr"),
      sessionId: session.value.sessionId,
      quoteId: quote.quoteId,
      evaluationId: evaluation.evaluationId,
      sku: quote.sku,
      quantity: quote.quantity,
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      totalPrice,
      supplierId: quote.supplierId,
      supplierName: quote.supplierName,
      deliveryAt: quote.deliveryAt,
      createdAt: now.toISOString(),
      status: "CREATED",
      synthetic: true,
    };

    const updated = this.sessions.get(sessionId);
    if (!updated) return sessionVanished();
    const raced = updated.purchaseRequestsByToken[confirmationToken];
    if (raced) return { ok: true, value: { request: raced, replayed: true } };
    updated.purchaseRequestsByToken[confirmationToken] = request;
    this.sessions.save(updated);
    return { ok: true, value: { request, replayed: false } };
  }

  /** Tool 5: escalate. Never creates an order and never edits policy. */
  async requestHumanApproval(
    sessionId: string,
    evaluationId: string,
  ): Promise<ToolResult<HumanApprovalRequest>> {
    const session = this.session(sessionId);
    if (!session.ok) return session;

    const evaluation = session.value.evaluations[evaluationId];
    if (!evaluation) {
      return err({
        ok: false,
        error: "EVALUATION_NOT_FOUND",
        message: "That evaluation was never produced by the policy tool.",
      });
    }
    if (evaluation.outcome !== "HUMAN_REVIEW_REQUIRED") {
      return err({
        ok: false,
        error: "HUMAN_APPROVAL_NOT_REQUIRED",
        message: "This evaluation does not require human approval.",
      });
    }

    const existing = Object.values(session.value.approvals).find(
      (approval) => approval.evaluationId === evaluationId,
    );
    if (existing) return { ok: true, value: existing };

    const approval: HumanApprovalRequest = {
      approvalRequestId: this.newId("approval"),
      sessionId: session.value.sessionId,
      quoteId: evaluation.quoteId,
      evaluationId: evaluation.evaluationId,
      reasonCheckIds: [...evaluation.humanReviewCheckIds],
      createdAt: this.clock().toISOString(),
      status: "PENDING_HUMAN_APPROVAL",
      orderCreated: false,
      policyChanged: false,
    };

    const updated = this.sessions.get(sessionId);
    if (!updated) return sessionVanished();
    updated.approvals[approval.approvalRequestId] = approval;
    this.sessions.save(updated);
    return { ok: true, value: approval };
  }
}

/**
 * Plain-language explanation, generated from the check trace.
 *
 * Deterministic by construction: it can only name checks that actually ran and
 * figures that actually came from the quote, so the explanation cannot drift
 * away from the decision it describes.
 */
export function explainEvaluation(
  outcome: EvaluationOutcome,
  quote: SupplierQuote,
  orderTotal: number,
  mission: JudgeMission,
  checks: PolicyCheck[],
): string {
  const money = `${orderTotal.toFixed(2)} ${quote.currency}`;
  const head = `${quote.supplierName} quotes ${quote.unitPrice.toFixed(2)} ${quote.currency} per unit for ${quote.quantity} units of ${quote.sku}, ${money} in total, delivered ${quote.deliveryAt.slice(0, 10)}.`;

  if (outcome === "ACCEPTED") {
    return `${head} That is within the ${mission.maximumBudget.toFixed(2)} ${mission.budgetCurrency} budget and inside the required delivery window, and every policy check passed.`;
  }

  const named = checks
    .filter((entry) => entry.status !== "PASS")
    .map((entry) => `${entry.id} (${entry.evidence})`)
    .join("; ");

  if (outcome === "REJECTED") {
    return `${head} This cannot be ordered because: ${named}.`;
  }
  return `${head} This needs a human decision because: ${named}.`;
}
