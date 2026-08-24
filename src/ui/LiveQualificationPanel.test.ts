import { describe, expect, it } from "vitest";
import {
  liveQualificationResultText,
  type LiveQualificationEnvelope,
} from "./liveQualificationResultText";

function envelope(
  outcome: string,
  evidence: "VERIFIED" | "UNVERIFIED" | "NOT_PROVIDED",
): LiveQualificationEnvelope {
  return {
    runtime: "LIVE_CALLE",
    liveCall: {
      callId: "call-real-01",
      outcome,
      taskCompleted: outcome === "ANSWERED",
      attemptCount: 1,
    },
    workflow: {
      purchaseOrder: null,
      decision: {
        rejectedOffers: [{
          offer: {
            commercialTermsChanged: true,
            evidenceStatus: { commercialTermsChanged: evidence },
          },
        }],
      },
    },
  } as unknown as LiveQualificationEnvelope;
}

describe("live qualification result text", () => {
  it("uses neutral wording when a timeout has no structured evidence", () => {
    const text = liveQualificationResultText(
      envelope("TIMEOUT", "NOT_PROVIDED"),
    );

    expect(text).toBe(
      "The live qualification did not return a structured supplier result. No purchase order was created.",
    );
    expect(text).not.toContain("intentionally changes payment terms");
  });

  it("mentions changed terms only when the answered call verifies them", () => {
    expect(liveQualificationResultText(envelope("ANSWERED", "VERIFIED"))).toContain(
      "intentionally changes payment terms",
    );
    expect(liveQualificationResultText(envelope("ANSWERED", "UNVERIFIED"))).not.toContain(
      "intentionally changes payment terms",
    );
  });
});
