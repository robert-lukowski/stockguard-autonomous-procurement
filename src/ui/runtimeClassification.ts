/**
 * Runtime classification.
 *
 * Every surface that shows a result must state which runtime produced it.
 * These five labels are the only permitted values. Availability describes the
 * final deployed judge build; a result may still use the live label only when
 * the backend itself reports LIVE_CALLE for that run.
 */
export type RuntimeClassificationId =
  | "MOCK_RUNTIME"
  | "SYNTHETIC_SUPPLIER_SIMULATOR"
  | "RECORDED_CALLE_EVIDENCE"
  | "LIVE_CALLE_CALL"
  | "HUMAN_MANAGER_ESCALATION";

export type RuntimeClassification = {
  id: RuntimeClassificationId;
  label: string;
  /** One line a judge can read without prior context. */
  meaning: string;
  /** Whether the final judge build contains a path that can produce it. */
  available: boolean;
  /** Tailwind classes. Colour is semantic, not decorative. */
  tone: string;
  dot: string;
};

export const runtimeClassifications: Record<
  RuntimeClassificationId,
  RuntimeClassification
> = {
  MOCK_RUNTIME: {
    id: "MOCK_RUNTIME",
    label: "Mock Runtime",
    meaning:
      "Deterministic in-browser data. No network call of any kind is made.",
    available: true,
    tone: "border-ground-600/60 bg-ground-800/70 text-ground-200",
    dot: "bg-ground-400",
  },
  SYNTHETIC_SUPPLIER_SIMULATOR: {
    id: "SYNTHETIC_SUPPLIER_SIMULATOR",
    label: "Synthetic Supplier Simulator",
    meaning:
      "Deterministic synthetic supplier profiles. A test counterparty, never a real company.",
    available: true,
    tone: "border-signal-500/45 bg-signal-500/12 text-signal-300",
    dot: "bg-signal-400",
  },
  RECORDED_CALLE_EVIDENCE: {
    id: "RECORDED_CALLE_EVIDENCE",
    label: "Recorded CALL-E Evidence",
    meaning:
      "A transcript and structured result captured from a real earlier CALL-E call.",
    available: false,
    tone: "border-proof-500/40 bg-proof-500/10 text-proof-300",
    dot: "bg-proof-500",
  },
  LIVE_CALLE_CALL: {
    id: "LIVE_CALLE_CALL",
    label: "Live CALL-E Call",
    meaning:
      "A real outbound telephone call placed through CALL-E right now.",
    available: true,
    tone: "border-review-500/40 bg-review-500/10 text-review-300",
    dot: "bg-review-500",
  },
  HUMAN_MANAGER_ESCALATION: {
    id: "HUMAN_MANAGER_ESCALATION",
    label: "Human Manager Escalation",
    meaning:
      "The bounded exception path used when no supplier offer satisfies policy.",
    available: true,
    tone: "border-review-500/45 bg-review-500/12 text-review-300",
    dot: "bg-review-500",
  },
};

export const runtimeClassificationOrder: RuntimeClassificationId[] = [
  "MOCK_RUNTIME",
  "SYNTHETIC_SUPPLIER_SIMULATOR",
  "HUMAN_MANAGER_ESCALATION",
  "RECORDED_CALLE_EVIDENCE",
  "LIVE_CALLE_CALL",
];

/** Decision semantics shared by the policy table and the offer table. */
export const decisionTone: Record<
  "PASS" | "FAIL" | "REQUIRES_HUMAN",
  { tone: string; label: string }
> = {
  PASS: {
    tone: "border-pass-500/40 bg-pass-500/12 text-pass-300",
    label: "Pass",
  },
  FAIL: {
    tone: "border-block-500/40 bg-block-500/12 text-block-300",
    label: "Fail",
  },
  REQUIRES_HUMAN: {
    tone: "border-review-500/40 bg-review-500/12 text-review-300",
    label: "Needs human",
  },
};

/**
 * Maps a runtime reported by a backend onto a classification. A live badge is
 * earned only by a backend that reports LIVE_CALLE for an actual run — never
 * by the mere presence of a configured backend URL.
 */
export function classificationForBackendRuntime(
  runtime: "LIVE_CALLE" | "MOCK",
): RuntimeClassificationId {
  return runtime === "LIVE_CALLE" ? "LIVE_CALLE_CALL" : "MOCK_RUNTIME";
}
