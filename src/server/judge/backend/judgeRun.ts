import type { ManagerEscalationContext } from "../../escalation";
import type {
  EscalationContextPort,
  JudgeRunPreparationPort,
  PreparedJudgeRun,
} from "./types";

/**
 * The canonical synthetic Judge escalation scenario.
 *
 * This mirrors the no-compliant-offer outcome the public walkthrough reaches:
 * three approved suppliers respond, and each fails a different deterministic
 * rule, so no purchase order is created and a bounded manager escalation is
 * the only remaining action.
 *
 * It is a fixed synthetic record on purpose. The live Judge path must not let
 * the browser assert workflow state, and this scope deliberately does not
 * introduce a general run engine to recompute it server-side. When a real
 * backend-owned supplier workflow exists, it can implement
 * `JudgeRunPreparationPort` instead and the frontend will not change.
 *
 * The supplier phase this describes is synthetic in every case. A live manager
 * call does not make these supplier offers live CALL-E evidence.
 */
export const canonicalJudgeEscalationContext: ManagerEscalationContext = {
  organizationName: "Northstar Manufacturing",
  sku: "CF-220",
  requiredQuantity: 8,
  stockoutAt: "2026-08-28T12:00:00+02:00",
  rejectedOffers: [
    {
      supplierName: "NordWerk Supply",
      failedChecks: ["quantity_sufficient"],
      requiresHumanChecks: [],
    },
    {
      supplierName: "Fourniture Atlas",
      failedChecks: ["delivery_before_stockout"],
      requiresHumanChecks: [],
    },
    {
      supplierName: "PolStock Components",
      failedChecks: [],
      requiresHumanChecks: ["commercial_terms_unchanged"],
    },
  ],
};

function opaqueRunSuffix(bytes = 12): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Mints one server-owned run per judge session and serves its context.
 *
 * Implements `EscalationContextPort` as well, so `startManagerCall` resolves
 * the context through the same object that minted the run. A runId this
 * preparer did not mint resolves to `null` and is therefore never eligible.
 */
export class SyntheticJudgeRunPreparer
  implements JudgeRunPreparationPort, EscalationContextPort
{
  private readonly runs = new Map<string, ManagerEscalationContext>();

  constructor(
    private readonly context: ManagerEscalationContext = canonicalJudgeEscalationContext,
  ) {}

  async prepareRun(sessionId: string): Promise<PreparedJudgeRun> {
    const runId = `judge-run-${opaqueRunSuffix()}`;
    this.runs.set(runId, structuredClone(this.context));
    void sessionId;
    return { runId, context: structuredClone(this.context) };
  }

  async getEscalationContext(runId: string): Promise<ManagerEscalationContext | null> {
    const context = this.runs.get(runId);
    return context ? structuredClone(context) : null;
  }
}
