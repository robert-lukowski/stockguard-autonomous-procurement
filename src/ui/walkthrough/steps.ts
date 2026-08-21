import type { RuntimeClassificationId } from "../runtimeClassification";

export type StepId =
  | "shortage"
  | "rfq"
  | "contact"
  | "offers"
  | "policy"
  | "noncompliance"
  | "escalation"
  | "proof";

export type StepDefinition = {
  id: StepId;
  /** Short label for the rail. */
  title: string;
  /** The single decision this screen exists to support. */
  question: string;
  /**
   * True when the primary action actually computes something. Review steps
   * complete on arrival so their only action is to move on - the button must
   * never imply work that already happened.
   */
  computes: boolean;
  /** Label of the one primary action. Only used when `computes` is true. */
  action: string;
  /** Label once the action has been performed. */
  actionDone: string;
  /** Which runtime produced everything on this screen. */
  runtime: RuntimeClassificationId;
  /**
   * Shown alongside `runtime` when the primary label alone could be read as
   * something live having happened. Nothing on a screen carrying
   * MOCK_RUNTIME here reached a network or a telephone.
   */
  secondaryRuntime?: RuntimeClassificationId;
  /** Plain-English outcome, filled in after the action runs. */
  whatHappened: string;
  whyItMatters: string;
};

export const walkthroughSteps: StepDefinition[] = [
  {
    id: "shortage",
    title: "Detect shortage",
    question: "Is there a material shortage that needs acting on?",
    computes: true,
    action: "Run shortage detection",
    actionDone: "Shortage detected",
    runtime: "MOCK_RUNTIME",
    whatHappened:
      "StockGuard netted confirmed demand and safety stock against stock on hand and confirmed inbound, and found a gap before the projected stockout date.",
    whyItMatters:
      "Everything downstream is bounded by this number. The agent may only ask for the quantity the shortage justifies — it cannot invent demand on a call.",
  },
  {
    id: "rfq",
    title: "Prepare RFQ",
    question: "What exactly will the agent be allowed to ask for?",
    computes: false,
    action: "Continue",
    actionDone: "RFQ reviewed",
    runtime: "MOCK_RUNTIME",
    whatHappened:
      "One RFQ was issued per approved supplier, each pinned to a routing code, a dataset version and an explicit call authorization that names the allowed suppliers and phone numbers.",
    whyItMatters:
      "The authorization is checked before any call starts. A supplier or number outside this list is refused by code, not by prompt wording.",
  },
  {
    id: "contact",
    title: "Contact suppliers",
    question: "What did the suppliers actually say?",
    computes: true,
    action: "Contact 3 approved suppliers",
    actionDone: "3 supplier responses collected",
    runtime: "SYNTHETIC_SUPPLIER_SIMULATOR",
    secondaryRuntime: "MOCK_RUNTIME",
    whatHappened:
      "Three supplier conversations were simulated against deterministic synthetic profiles. Each produced a structured offer plus a quoted excerpt for every commercial field. No telephone call was placed.",
    whyItMatters:
      "In production this is the CALL-E leg. The point of the phone call is to reach suppliers who have no API or EDI integration — which is most of the long tail.",
  },
  {
    id: "offers",
    title: "Review offers",
    question: "Is each number backed by something the supplier actually said?",
    computes: false,
    action: "Continue",
    actionDone: "Offers reviewed",
    runtime: "SYNTHETIC_SUPPLIER_SIMULATOR",
    secondaryRuntime: "MOCK_RUNTIME",
    whatHappened:
      "Every offer was normalized to EUR, and each commercial field carries an evidence excerpt that was checked against the call transcript.",
    whyItMatters:
      "A model can state a price confidently and still be wrong. An excerpt that does not appear in the transcript is downgraded rather than trusted.",
  },
  {
    id: "policy",
    title: "Policy Gateway",
    question: "Does any offer satisfy every procurement rule?",
    computes: false,
    action: "Continue",
    actionDone: "Policy trace reviewed",
    runtime: "MOCK_RUNTIME",
    whatHappened:
      "Thirteen deterministic checks were evaluated against each offer during the calls. Each returns pass, fail, or needs-human, together with the inputs it used.",
    whyItMatters:
      "The language model never decides. It gathers evidence; ordinary code decides. That separation is what makes an autonomous purchase defensible.",
  },
  {
    id: "noncompliance",
    title: "Why nothing qualifies",
    question: "Why can StockGuard not simply buy the cheapest offer?",
    computes: false,
    action: "Continue",
    actionDone: "Rejections reviewed",
    runtime: "MOCK_RUNTIME",
    whatHappened:
      "Each supplier failed on a different, specific rule. No offer passed every check, so no purchase order was created.",
    whyItMatters:
      "Refusing to act is the correct autonomous outcome here. A system that always finds a way to buy has no real policy.",
  },
  {
    id: "escalation",
    title: "Escalate to a manager",
    question: "Can a human on the phone override the policy?",
    computes: true,
    action: "Place the manager escalation call",
    actionDone: "Manager response recorded",
    runtime: "HUMAN_MANAGER_ESCALATION",
    secondaryRuntime: "MOCK_RUNTIME",
    whatHappened:
      "StockGuard assembled the escalation brief — every rejected offer and the rule it failed — and recorded one bounded decision from the duty procurement manager. The call itself was simulated; no number was dialled.",
    whyItMatters:
      "Try the override option. A spoken request to raise the budget is recorded as evidence and converted to a request for authenticated approval — it never changes policy and never creates an order.",
  },
  {
    id: "proof",
    title: "Verify the proof",
    question: "Can this decision be audited after the fact?",
    computes: true,
    action: "Verify the Decision Proof",
    actionDone: "Proof verified",
    runtime: "MOCK_RUNTIME",
    whatHappened:
      "The full decision record — rule trace, evidence hashes, manager response and audit chain — was hashed and signed, and the signature verifies.",
    whyItMatters:
      "Tamper with any field and verification fails. That gives procurement and audit a record they can check without trusting StockGuard.",
  },
];

export const totalSteps = walkthroughSteps.length;
