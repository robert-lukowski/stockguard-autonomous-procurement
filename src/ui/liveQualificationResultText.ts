import type { WorkflowResult } from "../server/workflow";

export type LiveQualificationEnvelope = {
  runtime: "LIVE_CALLE";
  liveCall: {
    callId: string | null;
    outcome: string | null;
    taskCompleted: boolean | null;
    attemptCount: number | null;
  } | null;
  workflow: WorkflowResult;
};

const CHANGED_TERMS_RESULT_TEXT =
  "The supplier intentionally changes payment terms. StockGuard therefore stops at human escalation instead of creating an autonomous purchase order.";
const MISSING_RESULT_TEXT =
  "The live qualification did not return a structured supplier result. No purchase order was created.";

export function liveQualificationResultText(
  result: LiveQualificationEnvelope,
): string {
  const hasVerifiedChangedTerms =
    result.liveCall?.outcome === "ANSWERED" &&
    (result.workflow.decision?.rejectedOffers.some(
      ({ offer }) =>
        offer.commercialTermsChanged === true &&
        offer.evidenceStatus.commercialTermsChanged === "VERIFIED",
    ) ?? false);

  return hasVerifiedChangedTerms
    ? CHANGED_TERMS_RESULT_TEXT
    : MISSING_RESULT_TEXT;
}
