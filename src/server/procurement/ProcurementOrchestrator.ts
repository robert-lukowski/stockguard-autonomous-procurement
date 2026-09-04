import { auditEvent, buildAuditProof, type ProcurementAuditEvent, type ProcurementAuditProof } from "./audit";
import { findCatalogItem } from "./catalog";
import { findMission } from "./missions";
import {
  ambiguousProductMessage,
  DeterministicNarrator,
  narrateSafely,
  outOfDomainMessage,
  type ConversationNarrator,
} from "./narrator";
import {
  InMemoryMetricSink,
  type MetricSink,
  type ProcurementMetric,
  type ProcurementMetricName,
  procurementMetricUnits,
} from "./metrics";
import {
  InMemoryProcurementSessionStore,
  type ProcurementSession,
  type ProcurementSessionStore,
} from "./sessionStore";
import { ProcurementTools, type SupplierQuotePort } from "./tools";
import { interpretUtterance } from "./utterance";
import type {
  HumanApprovalRequest,
  InventorySearchResult,
  JudgeMission,
  PurchaseEvaluation,
  PurchaseRequest,
  RecognizedRequest,
  ResolvedRequest,
  RunOutcome,
  SupplierQuote,
  ToolErrorCode,
  ToolName,
} from "./types";

/**
 * Channel-independent procurement orchestration.
 *
 * The orchestrator owns the whole run: interpret, resolve, quote, evaluate,
 * confirm, create or escalate, persist, audit, measure. It has no idea which
 * channel it is serving.
 *
 * A channel adapter's entire job is to turn whatever it carries into a string
 * of user text and to render `TurnResult` back. The local text channel used by
 * the Judge Portal and the tests does that; a future Amazon Connect WebRTC or
 * Lex adapter will do the same, and will need no change here.
 */

export const SESSION_TTL_MS = 30 * 60_000;

export type ToolInvocationRecord = {
  tool: ToolName;
  ok: boolean;
  error?: ToolErrorCode;
  summary: string;
  at: string;
};

export type TurnResult = {
  sessionId: string;
  mission: JudgeMission;
  message: string;
  narrationMode: "narrated" | "deterministic-fallback";
  recognized: RecognizedRequest;
  resolved: ResolvedRequest | null;
  search: InventorySearchResult | null;
  quote: SupplierQuote | null;
  evaluation: PurchaseEvaluation | null;
  toolInvocations: ToolInvocationRecord[];
  /** Present only when policy accepted and a human must now confirm. */
  confirmationToken: string | null;
  outcome: RunOutcome | null;
};

export type ConfirmationResult = {
  sessionId: string;
  message: string;
  outcome: RunOutcome;
  purchaseRequest: PurchaseRequest | null;
  humanApproval: HumanApprovalRequest | null;
  replayed: boolean;
  toolInvocations: ToolInvocationRecord[];
};

export type RunReport = {
  sessionId: string;
  missionId: string;
  channel: string;
  outcome: RunOutcome | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  audit: ProcurementAuditProof;
  metrics: ProcurementMetric[];
};

export type ProcurementOrchestratorConfig = {
  sessions?: ProcurementSessionStore;
  metrics?: MetricSink;
  narrator?: ConversationNarrator;
  supplierQuotes?: SupplierQuotePort;
  clock?: () => Date;
  newId?: (prefix: string) => string;
  channel?: string;
};

let idCounter = 0;

function defaultId(prefix: string): string {
  idCounter += 1;
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : String(idCounter).padStart(8, "0");
  return `${prefix}-${random}`;
}

export class ProcurementOrchestrator {
  private readonly sessions: ProcurementSessionStore;
  private readonly metricSink: MetricSink;
  private readonly narrator: ConversationNarrator;
  private readonly clock: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly channel: string;
  /**
   * The tool boundary, exposed deliberately.
   *
   * A channel adapter (and a Lex fulfilment Lambda in particular) invokes
   * these directly as its tool implementations. They validate every argument
   * server-side, so direct access widens nothing.
   */
  readonly tools: ProcurementTools;
  private readonly emitted: ProcurementMetric[] = [];

  constructor(config: ProcurementOrchestratorConfig = {}) {
    this.sessions = config.sessions ?? new InMemoryProcurementSessionStore();
    this.metricSink = config.metrics ?? new InMemoryMetricSink();
    this.narrator = config.narrator ?? new DeterministicNarrator();
    this.clock = config.clock ?? (() => new Date());
    this.newId = config.newId ?? defaultId;
    this.channel = config.channel ?? "local-text";
    this.tools = new ProcurementTools({
      sessions: this.sessions,
      clock: this.clock,
      newId: this.newId,
      supplierQuotes: config.supplierQuotes,
    });
  }

  /**
   * `sessionId` rides in `properties`, never in `dimensions`.
   *
   * A CloudWatch dimension multiplies the metric's cardinality, and one
   * time series per session would be both expensive and useless to chart. It
   * is still recorded, so a run report can select exactly its own metrics.
   */
  private metric(
    name: ProcurementMetricName,
    value: number,
    missionId: string,
    sessionId: string,
    properties: Record<string, string | number | boolean> = {},
  ): void {
    const metric: ProcurementMetric = {
      name,
      value,
      unit: procurementMetricUnits[name],
      dimensions: { Channel: this.channel, MissionId: missionId },
      at: this.clock().toISOString(),
      properties: { ...properties, sessionId },
    };
    this.metricSink.record(metric);
    this.emitted.push(metric);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  async startSession(
    missionId: string,
    sessionId = this.newId("session"),
  ): Promise<ProcurementSession> {
    const mission = findMission(missionId);
    if (!mission) throw new Error(`Unknown mission ${missionId}`);

    const now = this.clock();
    const session: ProcurementSession = {
      sessionId,
      missionId: mission.missionId,
      channel: this.channel,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      quotes: {},
      evaluations: {},
      purchaseRequestsByToken: {},
      approvals: {},
      audit: [
        auditEvent("SESSION_STARTED", sessionId, now.toISOString(), {
          missionId: mission.missionId,
          channel: this.channel,
        }),
      ],
      outcome: null,
      completedAt: null,
    };
    if ((await this.sessions.create(session)) === "DUPLICATE") {
      throw new Error(`Session ${sessionId} already exists`);
    }
    this.metric("RunStarted", 1, mission.missionId, sessionId);
    return session;
  }

  /**
   * One conversational turn: everything up to, but not including, the human's
   * decision.
   *
   * The turn deliberately stops at the confirmation request. Creating the
   * purchase request is a separate call because it needs a separate, explicit
   * human act — not a sentence a model decided sounded like agreement.
   *
   * Audit events are collected locally and appended in one call at the end of
   * the turn. The tools own their own writes, so the orchestrator never needs
   * to read a session back just to carry its audit forward.
   */
  async handleUtterance(sessionId: string, text: string): Promise<TurnResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const mission = findMission(session.missionId);
    if (!mission) throw new Error(`Unknown mission ${session.missionId}`);

    const invocations: ToolInvocationRecord[] = [];
    const events: ProcurementAuditEvent[] = [];
    const record = (
      type: Parameters<typeof auditEvent>[0],
      detail: Record<string, string | number | boolean | null> = {},
    ) => events.push(auditEvent(type, sessionId, this.now(), detail));

    const recognized = interpretUtterance(text);
    record("UTTERANCE_RECEIVED", { characters: text.length });

    const assumed: ResolvedRequest["assumed"] = [];
    if (recognized.quantity === null) assumed.push("quantity");
    if (recognized.requiredWithinDays === null) assumed.push("requiredWithinDays");
    const resolved: ResolvedRequest = {
      productQuery: recognized.productQuery,
      quantity: recognized.quantity ?? mission.requestedQuantity,
      requiredWithinDays: recognized.requiredWithinDays ?? mission.requiredDeliveryDays,
      assumed,
    };
    record("REQUEST_INTERPRETED", {
      productQuery: resolved.productQuery,
      quantity: resolved.quantity,
      requiredWithinDays: resolved.requiredWithinDays,
      assumedFields: assumed.join(",") || "none",
    });

    const search = this.tools.searchInventory(resolved.productQuery, mission.allowedCategories);
    invocations.push({
      tool: "searchInventory",
      ok: search.ok,
      ...(search.ok ? {} : { error: search.error }),
      summary: search.ok ? search.value.status : search.error,
      at: this.now(),
    });

    if (!search.ok || search.value.status === "OUT_OF_DOMAIN") {
      const searchResult: InventorySearchResult = search.ok
        ? search.value
        : {
            status: "OUT_OF_DOMAIN",
            query: resolved.productQuery,
            matches: [],
            supportedCategories: mission.allowedCategories,
          };
      record("OUT_OF_DOMAIN_REJECTED", { productQuery: resolved.productQuery });
      const narration = await narrateSafely(this.narrator, {
        kind: "OUT_OF_DOMAIN",
        deterministicMessage: outOfDomainMessage(searchResult, mission),
        allowedFigures: [],
        facts: { productQuery: resolved.productQuery },
      });
      return this.finishTurn(sessionId, mission, events, {
        message: narration.message,
        narrationMode: narration.mode,
        recognized,
        resolved,
        search: searchResult,
        quote: null,
        evaluation: null,
        toolInvocations: invocations,
        confirmationToken: null,
        outcome: "OUT_OF_DOMAIN",
      });
    }

    if (search.value.status === "AMBIGUOUS") {
      const narration = await narrateSafely(this.narrator, {
        kind: "AMBIGUOUS_PRODUCT",
        deterministicMessage: ambiguousProductMessage(search.value),
        allowedFigures: search.value.matches.map((match) => match.sku),
        facts: { matches: search.value.matches.length },
      });
      return this.finishTurn(sessionId, mission, events, {
        message: narration.message,
        narrationMode: narration.mode,
        recognized,
        resolved,
        search: search.value,
        quote: null,
        evaluation: null,
        toolInvocations: invocations,
        confirmationToken: null,
        outcome: null,
      });
    }

    const match = search.value.matches[0];
    record("PRODUCT_RESOLVED", { sku: match.sku, name: match.name, score: match.score });

    const requiredBy = new Date(
      this.clock().getTime() + resolved.requiredWithinDays * 24 * 60 * 60_000,
    ).toISOString();

    const quoteResult = await this.tools.getSupplierQuote(
      sessionId,
      match.sku,
      resolved.quantity,
      requiredBy,
    );
    invocations.push({
      tool: "getSupplierQuote",
      ok: quoteResult.ok,
      ...(quoteResult.ok ? {} : { error: quoteResult.error }),
      summary: quoteResult.ok ? quoteResult.value.quoteId : quoteResult.error,
      at: this.now(),
    });

    if (!quoteResult.ok) {
      record("TOOL_FAILED", { tool: "getSupplierQuote", error: quoteResult.error });
      this.metric("ToolError", 1, mission.missionId, sessionId, {
        tool: "getSupplierQuote",
        error: quoteResult.error,
      });
      const narration = await narrateSafely(this.narrator, {
        kind: "TOOL_FAILURE",
        deterministicMessage: quoteResult.message,
        allowedFigures: [String(resolved.quantity)],
        facts: { error: quoteResult.error },
      });
      return this.finishTurn(sessionId, mission, events, {
        message: narration.message,
        narrationMode: narration.mode,
        recognized,
        resolved,
        search: search.value,
        quote: null,
        evaluation: null,
        toolInvocations: invocations,
        confirmationToken: null,
        outcome:
          quoteResult.error === "SUPPLIER_TOOL_UNAVAILABLE"
            ? "TOOL_FAILURE"
            : "REJECTED_BY_POLICY",
      });
    }

    const quote = quoteResult.value;
    record("QUOTE_ISSUED", {
      quoteId: quote.quoteId,
      sku: quote.sku,
      quantity: quote.quantity,
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      deliveryAt: quote.deliveryAt,
      provenanceHash: quote.provenanceHash,
    });

    const evaluationResult = await this.tools.evaluatePurchase(
      sessionId,
      quote.quoteId,
      mission,
      resolved.requiredWithinDays,
    );
    invocations.push({
      tool: "evaluatePurchase",
      ok: evaluationResult.ok,
      ...(evaluationResult.ok ? {} : { error: evaluationResult.error }),
      summary: evaluationResult.ok ? evaluationResult.value.outcome : evaluationResult.error,
      at: this.now(),
    });

    if (!evaluationResult.ok) {
      record("TOOL_FAILED", { tool: "evaluatePurchase", error: evaluationResult.error });
      this.metric("ToolError", 1, mission.missionId, sessionId, {
        tool: "evaluatePurchase",
        error: evaluationResult.error,
      });
      return this.finishTurn(sessionId, mission, events, {
        message: evaluationResult.message,
        narrationMode: "deterministic-fallback",
        recognized,
        resolved,
        search: search.value,
        quote,
        evaluation: null,
        toolInvocations: invocations,
        confirmationToken: null,
        outcome: "TOOL_FAILURE",
      });
    }

    const evaluation = evaluationResult.value;
    record("POLICY_EVALUATED", {
      evaluationId: evaluation.evaluationId,
      outcome: evaluation.outcome,
      orderTotal: evaluation.orderTotal,
      currency: evaluation.orderCurrency,
      blockingChecks: evaluation.blockingCheckIds.join(",") || "none",
      humanReviewChecks: evaluation.humanReviewCheckIds.join(",") || "none",
    });

    const narration = await narrateSafely(this.narrator, {
      kind: "EVALUATION_EXPLAINED",
      deterministicMessage: evaluation.explanation,
      allowedFigures: [
        String(quote.unitPrice),
        String(quote.quantity),
        String(quote.availableQuantity),
        String(evaluation.orderTotal),
        String(mission.maximumBudget),
        String(resolved.requiredWithinDays),
        quote.deliveryAt,
        quote.offerValidUntil,
        quote.sku,
      ],
      facts: {
        outcome: evaluation.outcome,
        sku: quote.sku,
        supplier: quote.supplierName,
      },
    });

    if (evaluation.outcome === "ACCEPTED") {
      record("CONFIRMATION_REQUESTED", { evaluationId: evaluation.evaluationId });
    }

    /*
     * A rejection is terminal: nothing further can be asked of the judge, so
     * the run completes here and is counted. ACCEPTED and HUMAN_REVIEW_REQUIRED
     * both stay open, because each is waiting on a separate, explicit human act
     * (`confirm` and `escalate` respectively).
     */
    return this.finishTurn(sessionId, mission, events, {
      message:
        evaluation.outcome === "ACCEPTED"
          ? `${narration.message} Shall I create the purchase request?`
          : narration.message,
      narrationMode: narration.mode,
      recognized,
      resolved,
      search: search.value,
      quote,
      evaluation,
      toolInvocations: invocations,
      confirmationToken: evaluation.confirmationToken,
      outcome: evaluation.outcome === "REJECTED" ? "REJECTED_BY_POLICY" : null,
    });
  }

  private async finishTurn(
    sessionId: string,
    mission: JudgeMission,
    events: ProcurementAuditEvent[],
    turn: Omit<TurnResult, "sessionId" | "mission">,
  ): Promise<TurnResult> {
    if (turn.outcome !== null) {
      await this.completeRun(sessionId, mission, turn.outcome, events);
    } else {
      await this.sessions.appendAudit(sessionId, events);
    }
    return { sessionId, mission, ...turn };
  }

  /**
   * Marks the run finished and emits its outcome metrics.
   *
   * The store decides whether this call is the one that completes the run.
   * Only `COMPLETED` emits metrics, so a replayed confirmation or a concurrent
   * request cannot inflate the accepted-run count in CloudWatch or Grafana.
   */
  private async completeRun(
    sessionId: string,
    mission: JudgeMission,
    outcome: RunOutcome,
    events: ProcurementAuditEvent[] = [],
  ): Promise<"COMPLETED" | "ALREADY_COMPLETED"> {
    const completedAt = this.now();
    const status = await this.sessions.complete(sessionId, outcome, completedAt);
    await this.sessions.appendAudit(sessionId, [
      ...events,
      ...(status === "COMPLETED"
        ? [auditEvent("RUN_COMPLETED", sessionId, completedAt, { outcome })]
        : []),
    ]);
    if (status === "ALREADY_COMPLETED") return status;

    const session = await this.sessions.get(sessionId);
    const startedAt = session?.startedAt ?? completedAt;

    if (outcome === "PURCHASE_REQUEST_CREATED") {
      this.metric("RunAccepted", 1, mission.missionId, sessionId);
    }
    if (
      outcome === "REJECTED_BY_POLICY" ||
      outcome === "OUT_OF_DOMAIN" ||
      outcome === "DECLINED_BY_USER"
    ) {
      this.metric("RunRejected", 1, mission.missionId, sessionId, { outcome });
    }
    if (outcome === "HUMAN_APPROVAL_REQUESTED") {
      this.metric("RunHumanReview", 1, mission.missionId, sessionId);
    }
    this.metric(
      "RunDurationMs",
      Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      mission.missionId,
      sessionId,
      { outcome },
    );
    return status;
  }

  /**
   * The human's decision.
   *
   * `accepted === false` is a first-class outcome, not an absence of one: a
   * judge who declines must leave the same audit evidence as one who agrees.
   */
  async confirm(
    sessionId: string,
    evaluationId: string,
    confirmationToken: string,
    accepted: boolean,
  ): Promise<ConfirmationResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const mission = findMission(session.missionId);
    if (!mission) throw new Error(`Unknown mission ${session.missionId}`);

    const invocations: ToolInvocationRecord[] = [];

    if (!accepted) {
      await this.completeRun(sessionId, mission, "DECLINED_BY_USER", [
        auditEvent("CONFIRMATION_DECLINED", sessionId, this.now(), { evaluationId }),
      ]);
      return {
        sessionId,
        message: "Understood. I have not created a purchase request.",
        outcome: "DECLINED_BY_USER",
        purchaseRequest: null,
        humanApproval: null,
        replayed: false,
        toolInvocations: invocations,
      };
    }

    const events: ProcurementAuditEvent[] = [
      auditEvent("CONFIRMATION_RECEIVED", sessionId, this.now(), { evaluationId }),
    ];

    const result = await this.tools.createPurchaseRequest(
      sessionId,
      evaluationId,
      confirmationToken,
      mission,
    );
    invocations.push({
      tool: "createPurchaseRequest",
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
      summary: result.ok ? result.value.request.purchaseRequestId : result.error,
      at: this.now(),
    });

    if (!result.ok) {
      events.push(
        auditEvent("TOOL_FAILED", sessionId, this.now(), {
          tool: "createPurchaseRequest",
          error: result.error,
        }),
      );
      this.metric("ToolError", 1, mission.missionId, sessionId, {
        tool: "createPurchaseRequest",
        error: result.error,
      });
      await this.completeRun(sessionId, mission, "REJECTED_BY_POLICY", events);
      return {
        sessionId,
        message: result.message,
        outcome: "REJECTED_BY_POLICY",
        purchaseRequest: null,
        humanApproval: null,
        replayed: false,
        toolInvocations: invocations,
      };
    }

    const { request, replayed } = result.value;
    events.push(
      auditEvent(
        replayed ? "PURCHASE_REQUEST_REPLAYED" : "PURCHASE_REQUEST_CREATED",
        sessionId,
        this.now(),
        {
          purchaseRequestId: request.purchaseRequestId,
          sku: request.sku,
          quantity: request.quantity,
          totalPrice: request.totalPrice,
          currency: request.currency,
        },
      ),
    );

    if (replayed) {
      await this.sessions.appendAudit(sessionId, events);
    } else {
      await this.completeRun(sessionId, mission, "PURCHASE_REQUEST_CREATED", events);
    }

    return {
      sessionId,
      message: replayed
        ? `Purchase request ${request.purchaseRequestId} already exists for this confirmation; nothing was created twice.`
        : `Purchase request ${request.purchaseRequestId} created for ${request.quantity} units of ${request.sku} at ${request.totalPrice.toFixed(2)} ${request.currency}.`,
      outcome: "PURCHASE_REQUEST_CREATED",
      purchaseRequest: request,
      humanApproval: null,
      replayed,
      toolInvocations: invocations,
    };
  }

  /** Escalation path for a HUMAN_REVIEW_REQUIRED evaluation. */
  async escalate(sessionId: string, evaluationId: string): Promise<ConfirmationResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const mission = findMission(session.missionId);
    if (!mission) throw new Error(`Unknown mission ${session.missionId}`);

    const result = await this.tools.requestHumanApproval(sessionId, evaluationId);
    const invocations: ToolInvocationRecord[] = [
      {
        tool: "requestHumanApproval",
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
        summary: result.ok ? result.value.approvalRequestId : result.error,
        at: this.now(),
      },
    ];

    if (!result.ok) {
      await this.sessions.appendAudit(sessionId, [
        auditEvent("TOOL_FAILED", sessionId, this.now(), {
          tool: "requestHumanApproval",
          error: result.error,
        }),
      ]);
      this.metric("ToolError", 1, mission.missionId, sessionId, {
        tool: "requestHumanApproval",
        error: result.error,
      });
      return {
        sessionId,
        message: result.message,
        outcome: session.outcome ?? "REJECTED_BY_POLICY",
        purchaseRequest: null,
        humanApproval: null,
        replayed: false,
        toolInvocations: invocations,
      };
    }

    await this.completeRun(sessionId, mission, "HUMAN_APPROVAL_REQUESTED", [
      auditEvent("HUMAN_APPROVAL_REQUESTED", sessionId, this.now(), {
        approvalRequestId: result.value.approvalRequestId,
        reasons: result.value.reasonCheckIds.join(",") || "none",
      }),
    ]);

    return {
      sessionId,
      message: `This needs a human decision, so I have raised approval request ${result.value.approvalRequestId}. No order was created and no policy was changed.`,
      outcome: "HUMAN_APPROVAL_REQUESTED",
      purchaseRequest: null,
      humanApproval: result.value,
      replayed: false,
      toolInvocations: invocations,
    };
  }

  async report(sessionId: string): Promise<RunReport> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);

    return {
      sessionId,
      missionId: session.missionId,
      channel: session.channel,
      outcome: session.outcome,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      durationMs: session.completedAt
        ? Date.parse(session.completedAt) - Date.parse(session.startedAt)
        : null,
      audit: await buildAuditProof(session.audit),
      metrics: this.emitted
        .filter((metric) => metric.properties.sessionId === sessionId)
        .map((metric) => structuredClone(metric)),
    };
  }

  /** Exposed so a channel adapter can show what the catalog actually holds. */
  catalogItem(sku: string) {
    return findCatalogItem(sku);
  }
}
