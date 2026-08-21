import {
  Activity,
  BadgeCheck,
  Boxes,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  Languages,
  PackageCheck,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Truck,
} from "lucide-react";
import { useState } from "react";
import {
  guidedScenario,
  runManagerEscalationDemo,
  runDemoWorkflow,
  runSupplierSimulatorDemo,
  type DemoCallOutcome,
  type DemoScenario,
} from "./demo/runDemoWorkflow";
import type { WorkflowResult } from "./server/workflow";
import { verifyDecisionProof, type ProofVerification } from "./security";
import type { MockManagerResponse } from "./server/escalation";
import type { SupportedCallLocale } from "./server/calle";

type WorkflowStep = {
  label: string;
  detail: string;
  status: "complete" | "active" | "pending";
};

type SupplierOffer = {
  supplier: string;
  country: string;
  flag: string;
  language: string;
  quantity: number;
  unitPrice: string;
  normalizedTotal: string;
  delivery: string;
  outcome: "Selected" | "Too late" | "Insufficient" | "Terms changed" | "Over budget" | "Rejected";
  confidence: number;
};

const offers: SupplierOffer[] = [
  {
    supplier: "NordWerk Supply",
    country: "Germany",
    flag: "DE",
    language: "German",
    quantity: 8,
    unitPrice: "€42.00",
    normalizedTotal: "€336.00",
    delivery: "Thu, 27 Aug",
    outcome: "Selected",
    confidence: 96,
  },
  {
    supplier: "Fourniture Atlas",
    country: "France",
    flag: "FR",
    language: "French",
    quantity: 6,
    unitPrice: "€38.00",
    normalizedTotal: "€228.00",
    delivery: "Wed, 26 Aug",
    outcome: "Insufficient",
    confidence: 93,
  },
  {
    supplier: "PolStock Components",
    country: "Poland",
    flag: "PL",
    language: "Polish",
    quantity: 8,
    unitPrice: "158 PLN",
    normalizedTotal: "€294.40",
    delivery: "Mon, 31 Aug",
    outcome: "Too late",
    confidence: 95,
  },
];

const steps: WorkflowStep[] = [
  {
    label: "Shortage detected",
    detail: "8 units required before Friday 12:00",
    status: "complete",
  },
  {
    label: "Supplier calls complete",
    detail: "3 approved suppliers · 3 languages",
    status: "complete",
  },
  {
    label: "Policy validation",
    detail: "13 of 13 machine-enforced checks passed",
    status: "complete",
  },
  {
    label: "Purchase order created",
    detail: "PO-1042 · autonomous green zone",
    status: "active",
  },
];

const checks = [
  "Approved supplier",
  "Exact SKU confirmed",
  "Quantity sufficient",
  "Delivery before stockout",
  "Price below ceiling",
  "Budget available",
  "Approved currency",
  "Offer validity confirmed",
  "No new commercial terms",
  "Evidence complete",
  "Confidence above 90%",
  "Retry policy respected",
  "Recipient consent verified",
];

const exceptionJourney = [
  "Detect shortage",
  "Prepare RFQ",
  "Contact synthetic suppliers",
  "Collect and validate offers",
  "Run Policy Gateway",
  "No compliant offer",
  "Escalate to manager",
  "Verify signed Decision Proof",
];

const simulatorProfiles = [
  {
    id: "DE_SUPPLIER",
    locale: "German · de_DE",
    result: "70% available",
    rejection: "Insufficient quantity",
  },
  {
    id: "FR_SUPPLIER",
    locale: "French · fr_FR",
    result: "120% available · delivery +8d",
    rejection: "Delivery after stockout",
  },
  {
    id: "PL_SUPPLIER",
    locale: "Polish · pl_PL",
    result: "100% available · terms changed",
    rejection: "Commercial policy review",
  },
];

function StatusPill({ value }: { value: SupplierOffer["outcome"] }) {
  return <span className={`status-pill ${value.toLowerCase().replace(" ", "-")}`}>{value}</span>;
}

const supplierPresentation: Record<string, Pick<SupplierOffer, "country" | "flag" | "language">> = {
  "supplier-de-01": { country: "Germany", flag: "DE", language: "German" },
  "supplier-fr-01": { country: "France", flag: "FR", language: "French" },
  "supplier-pl-01": { country: "Poland", flag: "PL", language: "Polish" },
};

function outcomeForRejectedOffer(failedChecks: string[], humanChecks: string[]): SupplierOffer["outcome"] {
  const checks = [...failedChecks, ...humanChecks].join(" ").toLowerCase();
  if (checks.includes("quantity")) return "Insufficient";
  if (checks.includes("delivery")) return "Too late";
  if (checks.includes("commercial")) return "Terms changed";
  if (checks.includes("budget") || checks.includes("price")) return "Over budget";
  return "Rejected";
}

function App() {
  const [autonomyEnabled, setAutonomyEnabled] = useState(true);
  const [demoStatus, setDemoStatus] = useState<
    "idle" | "running" | "complete" | "blocked" | "error"
  >("idle");
  const [demoResult, setDemoResult] = useState<WorkflowResult | null>(null);
  const [proofVerification, setProofVerification] = useState<ProofVerification | null>(null);
  const [labMode, setLabMode] = useState<
    "guided" | "custom" | "simulator" | "manager"
  >("guided");
  const [scenario, setScenario] = useState<DemoScenario>(structuredClone(guidedScenario));
  const [managerResponse, setManagerResponse] = useState<MockManagerResponse>("ACKNOWLEDGE_AND_START_HUMAN_SOURCING");
  const [managerLocale, setManagerLocale] = useState<SupportedCallLocale>("en-GB");

  const runDemo = async () => {
    setDemoStatus("running");
    setDemoResult(null);
    setProofVerification(null);

    try {
      const result = labMode === "manager"
        ? await runManagerEscalationDemo(managerResponse, managerLocale)
        : labMode === "simulator"
          ? await runSupplierSimulatorDemo()
          : await runDemoWorkflow(
              autonomyEnabled,
              labMode === "guided" ? guidedScenario : scenario,
            );
      setDemoResult(result);
      if (result.signedProof) {
        setProofVerification(await verifyDecisionProof(result.signedProof));
      }
      setDemoStatus(
        result.status === "ORDER_CREATED" ||
          result.status === "ESCALATION_RECORDED" ||
          result.status === "AUTHENTICATED_APPROVAL_REQUIRED" ||
          (labMode === "simulator" && result.status === "HUMAN_ESCALATION_REQUIRED")
          ? "complete"
          : "blocked",
      );
    } catch {
      setDemoStatus("error");
    }
  };

  const setSupplierOutcome = (supplierId: string, outcome: DemoCallOutcome) => {
    setScenario((current) => ({
      ...current,
      supplierOutcomes: { ...current.supplierOutcomes, [supplierId]: outcome },
    }));
  };

  const verifyOriginalProof = async () => {
    if (demoResult?.signedProof) {
      setProofVerification(await verifyDecisionProof(demoResult.signedProof));
    }
  };

  const verifyTamperedCopy = async () => {
    if (!demoResult?.signedProof) return;
    const tampered = structuredClone(demoResult.signedProof);
    if (tampered.payload.managerEscalation) {
      tampered.payload.managerEscalation.effectiveDecision = "DECLINE_ESCALATION";
    } else {
      tampered.payload.orderValueEur = 1;
    }
    setProofVerification(await verifyDecisionProof(tampered));
  };

  const displayedSteps: WorkflowStep[] =
    demoStatus === "complete"
      ? steps
      : steps.map((step, index) => ({
          ...step,
          status:
            demoStatus === "running" && index === 0
              ? "active"
              : "pending",
        }));
  const displayedValidation =
    demoResult?.decision?.validation ??
    demoResult?.decision?.rejectedOffers[0]?.validation ??
    null;
  const displayedOffers: SupplierOffer[] = demoResult?.decision
    ? [
        ...(demoResult.decision.selectedOffer && demoResult.decision.validation
          ? [{
              offer: demoResult.decision.selectedOffer,
              outcome: "Selected" as const,
              failedChecks: [] as string[],
              humanChecks: [] as string[],
            }]
          : []),
        ...demoResult.decision.rejectedOffers.map(({ offer, validation }) => ({
          offer,
          outcome: outcomeForRejectedOffer(
            validation.failedCheckIds,
            validation.humanReviewCheckIds,
          ),
          failedChecks: validation.failedCheckIds,
          humanChecks: validation.humanReviewCheckIds,
        })),
      ].map(({ offer, outcome }) => ({
        supplier: offer.supplierName,
        ...(supplierPresentation[offer.supplierId] ?? {
          country: "Approved region",
          flag: "--",
          language: offer.language,
        }),
        quantity: offer.availableQuantity,
        unitPrice: `${offer.unitPrice.toFixed(2)} ${offer.currency}`,
        normalizedTotal: `€${offer.totalPriceEur.toFixed(2)}`,
        delivery: new Date(offer.deliveryAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
        }),
        outcome,
        confidence: Math.round(offer.completionConfidence * 100),
      }))
    : offers;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><ShieldCheck size={22} /></div>
          <div>
            <strong>StockGuard</strong>
            <span>Autonomous procurement</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <a className="nav-item active" href="#overview"><Activity size={18} /> Overview</a>
          <a className="nav-item" href="#inventory"><Boxes size={18} /> Inventory</a>
          <a className="nav-item" href="#suppliers"><Truck size={18} /> Suppliers</a>
          <a className="nav-item" href="#calls"><PhoneCall size={18} /> Call tasks</a>
          <a className="nav-item" href="#policies"><ShieldCheck size={18} /> Policies</a>
          <a className="nav-item" href="#evidence"><FileCheck2 size={18} /> Evidence</a>
        </nav>

        <div className="sidebar-footer">
          <div className="environment-dot" />
          <div><strong>Demo environment</strong><span>Synthetic data only</span></div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <div className="eyebrow"><Sparkles size={14} /> Autonomous workflow #WF-2026-081</div>
            <h1>Procurement control center</h1>
            <p>Predict shortages, call suppliers, validate evidence and execute within policy.</p>
          </div>
          <div className="topbar-actions">
            <button
              className="demo-run-button"
              disabled={demoStatus === "running"}
              onClick={runDemo}
            >
              <Sparkles size={16} />
              {demoStatus === "running"
                ? "Running workflow…"
                : labMode === "guided"
                  ? "Run Guided Demo"
                  : labMode === "custom"
                    ? "Run Custom Scenario"
                    : labMode === "simulator"
                      ? "Run Supplier Harness (Mock)"
                      : "Test Manager Escalation (Mock)"}
            </button>
            <div className="kill-switch">
              <div>
                <span>Autonomous execution</span>
                <strong>{autonomyEnabled ? "Enabled" : "Paused"}</strong>
              </div>
              <button
                aria-label="Toggle autonomous execution"
                aria-pressed={autonomyEnabled}
                className={autonomyEnabled ? "toggle enabled" : "toggle"}
                onClick={() => setAutonomyEnabled((current) => !current)}
              >
                <span />
              </button>
            </div>
            <button className="avatar" aria-label="Open user menu">RL</button>
          </div>
        </header>

        <section className="panel judge-lab-panel">
          <div className="lab-header">
            <div>
              <span className="section-kicker">Interactive Judge Lab</span>
              <h2>{labMode === "manager"
                ? "Resolve a no-compliant-offer exception"
                : labMode === "simulator"
                  ? "Test deterministic supplier conversations"
                  : "Control the procurement outcome"}</h2>
              <p>Public sandbox · synthetic calls · no phone number or secret required</p>
            </div>
            <div className="runtime-badge mock">
              {labMode === "simulator"
                ? "SYNTHETIC HARNESS · MOCK"
                : labMode === "manager"
                  ? "HUMAN ESCALATION · MOCK"
                  : "MOCK RUNTIME"}
            </div>
          </div>

          <div className="lab-mode-switch" role="tablist" aria-label="Demo mode">
            <button className={labMode === "guided" ? "active" : ""} onClick={() => setLabMode("guided")}>Guided Demo</button>
            <button className={labMode === "custom" ? "active" : ""} onClick={() => setLabMode("custom")}>Custom Scenario</button>
            <button className={labMode === "simulator" ? "active" : ""} onClick={() => setLabMode("simulator")}>Supplier Simulator · Mock</button>
            <button className={labMode === "manager" ? "active" : ""} onClick={() => setLabMode("manager")}>Manager Escalation · Mock</button>
            <button disabled title="Requires server-side authorization and configured CALL-E backend">Live Judge Mode · locked</button>
          </div>

          {(labMode === "simulator" || labMode === "manager") && (
            <div className="supplier-simulator-preview">
              <div className="simulator-heading">
                <div>
                  <span className="section-kicker">Synthetic Supplier Simulator</span>
                  <strong>A deterministic synthetic supplier test harness used to safely demonstrate real telephony integration.</strong>
                </div>
                <span className="simulator-safe-badge">No real supplier or order</span>
              </div>
              <div className="simulator-profile-grid">
                {simulatorProfiles.map((profile) => (
                  <div key={profile.id}>
                    <span>{profile.locale}</span>
                    <strong>{profile.id}</strong>
                    <small>{profile.result}</small>
                    <em>{profile.rejection}</em>
                  </div>
                ))}
              </div>
              <div className="runtime-legend" aria-label="Runtime classification">
                <span className="synthetic">Synthetic Supplier Simulator</span>
                <span className="mock">Mock Mode</span>
                <span className="locked">Live CALL-E Call · not connected</span>
                <span className="locked">Recorded CALL-E Evidence · mock preview</span>
                {labMode === "manager" && <span className="human">Human Manager Escalation</span>}
              </div>
              <div className="exception-journey" aria-label="Exception workflow stages">
                {exceptionJourney.map((stage, index) => {
                  const completed = Boolean(demoResult && (
                    index < 6 ||
                    (labMode === "manager" && index === 6) ||
                    (index === 7 && proofVerification?.valid)
                  ));
                  const active = Boolean(demoResult && (
                    (labMode === "simulator" && index === 6) ||
                    (labMode === "manager" && index === 7 && !proofVerification?.valid)
                  ));
                  return (
                    <div className={completed ? "complete" : active ? "active" : ""} key={stage}>
                      <span>{index + 1}</span>
                      <strong>{stage}</strong>
                    </div>
                  );
                })}
              </div>
              <details className="technical-details">
                <summary>View technical details</summary>
                <div>
                  <code>CALL-E → Amazon Connect → Lex V2 → Lambda → synthetic supplier data</code>
                  <p>One future Connect number routes by RFQ/profile. Lambda resolves dynamic state, preserves the StockGuard runId and returns intent-specific answers for quote, remainder, validity and commercial-terms follow-ups. The live path remains disabled.</p>
                </div>
              </details>
            </div>
          )}

          {labMode === "custom" && (
            <div className="scenario-controls">
              <label>Required quantity<input type="number" min="1" max="40" value={scenario.requiredQuantity} onChange={(event) => setScenario({ ...scenario, requiredQuantity: Number(event.target.value) })} /></label>
              <label>Autonomy budget (€)<input type="number" min="50" max="5000" value={scenario.budgetEur} onChange={(event) => setScenario({ ...scenario, budgetEur: Number(event.target.value) })} /></label>
              <label>Stockout deadline<input type="datetime-local" value={scenario.stockoutAt.slice(0, 16)} onChange={(event) => setScenario({ ...scenario, stockoutAt: `${event.target.value}:00+02:00` })} /></label>
              <label>NordWerk quantity<input type="number" min="0" max="40" value={scenario.primaryOfferQuantity} onChange={(event) => setScenario({ ...scenario, primaryOfferQuantity: Number(event.target.value) })} /></label>
              <label>NordWerk unit price (€)<input type="number" min="1" max="200" value={scenario.primaryOfferUnitPriceEur} onChange={(event) => setScenario({ ...scenario, primaryOfferUnitPriceEur: Number(event.target.value) })} /></label>
              {[
                ["supplier-de-01", "NordWerk · DE"],
                ["supplier-fr-01", "Atlas · FR"],
                ["supplier-pl-01", "PolStock · PL"],
              ].map(([supplierId, label]) => (
                <label key={supplierId}>{label}
                  <select value={scenario.supplierOutcomes[supplierId]} onChange={(event) => setSupplierOutcome(supplierId, event.target.value as DemoCallOutcome)}>
                    <option value="quote">Complete quote</option>
                    <option value="no-answer">No answer</option>
                    <option value="voicemail">Voicemail</option>
                    <option value="incomplete">Incomplete quote</option>
                    <option value="late">Late delivery</option>
                    <option value="expensive">Above price ceiling</option>
                    <option value="missing-webhook">Missing webhook</option>
                    <option value="connection-lost">Connection lost</option>
                    <option value="insufficient">Insufficient quantity</option>
                    <option value="terms-changed">Changed commercial terms</option>
                  </select>
                </label>
              ))}
            </div>
          )}
          {labMode === "manager" && (
            <div className="manager-preview">
              <div className="manager-controls">
                <label>Conversation language
                  <select value={managerLocale} onChange={(event) => setManagerLocale(event.target.value as SupportedCallLocale)}>
                    <option value="en-GB">English</option>
                    <option value="de-DE">German</option>
                    <option value="pl-PL">Polish</option>
                    <option value="fr-FR">French</option>
                  </select>
                </label>
                <label>Mock manager response
                  <select value={managerResponse} onChange={(event) => setManagerResponse(event.target.value as MockManagerResponse)}>
                    <option value="ACKNOWLEDGE_AND_START_HUMAN_SOURCING">Acknowledge · start human sourcing</option>
                    <option value="RETRY_APPROVED_SUPPLIERS_LATER">Retry approved suppliers later</option>
                    <option value="REQUEST_WRITTEN_REPORT">Request written report</option>
                    <option value="DECLINE_ESCALATION">Decline escalation</option>
                    <option value="ATTEMPT_POLICY_OVERRIDE">Try: increase budget and buy anyway</option>
                    <option value="UNVERIFIED_RESPONSE">Unverified evidence</option>
                    <option value="NO_ANSWER">No answer</option>
                  </select>
                </label>
              </div>
              <div className="manager-guardrail"><TriangleAlert size={16} /><span>Voice may acknowledge, schedule a retry or request a report. It cannot change budget, policy, supplier approval, legal terms or create an order.</span></div>
              {demoResult?.managerEscalation && (
                <div className="manager-result">
                  <div><span>Captured response</span><strong>{demoResult.managerEscalation.rawDecision.replaceAll("_", " ")}</strong></div>
                  <ChevronRight size={18} />
                  <div><span>Effective workflow decision</span><strong>{demoResult.managerEscalation.effectiveDecision.replaceAll("_", " ")}</strong></div>
                  <div className="evidence-chip"><BadgeCheck size={15} /> Evidence verified</div>
                </div>
              )}
            </div>
          )}
          <div className="judge-mode-note"><ShieldCheck size={16} /><span><strong>Live Judge Mode is fail-closed.</strong> The future backend will verify the Devpost-only code, create a short-lived one-call session, record explicit consent and submit the number to CALL-E. No valid code, phone number or credential exists in this frontend bundle.</span></div>
          <div className="resilience-badges" aria-label="Execution safeguards">
            <span>Idempotent run</span>
            <span>Webhook dedupe</span>
            <span>2-attempt retry cap</span>
            <span>Exactly-once synthetic PO</span>
            <span>Timeout → human review</span>
          </div>
        </section>

        <section className="metrics" aria-label="Workflow metrics">
          <article>
            <div className="metric-icon danger"><TriangleAlert size={19} /></div>
            <div><span>Predicted shortage</span><strong>8 units</strong><small>CF-220 Cooling Fan</small></div>
          </article>
          <article>
            <div className="metric-icon"><Clock3 size={19} /></div>
            <div><span>Time to stockout</span><strong>3d 4h</strong><small>Friday at 12:00 CEST</small></div>
          </article>
          <article>
            <div className="metric-icon"><Languages size={19} /></div>
            <div><span>Supplier coverage</span><strong>3 / 3</strong><small>German · French · Polish</small></div>
          </article>
          <article>
            <div className="metric-icon success">{demoResult?.managerEscalation ? <PhoneCall size={19} /> : <CircleDollarSign size={19} />}</div>
            <div><span>{demoResult?.managerEscalation ? "Manager decision" : "Selected order"}</span><strong>{demoResult?.managerEscalation ? "Recorded" : demoResult?.purchaseOrder ? `€${demoResult.purchaseOrder.totalPriceEur.toFixed(2)}` : "—"}</strong><small>{demoResult?.managerEscalation ? "No policy override · no order" : demoResult?.purchaseOrder ? "Within €500 autonomy limit" : "Run demo to execute"}</small></div>
          </article>
        </section>

        <section className="content-grid">
          <article className="panel shortage-card" id="overview">
            <div className="panel-heading">
              <div>
                <span className="section-kicker">Demand intelligence</span>
                <h2>Shortage forecast</h2>
              </div>
              <span className="risk-badge">Action required</span>
            </div>

            <div className="sku-heading">
              <div className="part-icon"><Boxes size={28} /></div>
              <div><strong>CF-220</strong><span>Cooling Fan Assembly</span></div>
              <div className="forecast-confidence"><span>Forecast confidence</span><strong>94%</strong></div>
            </div>

            <div className="stock-equation">
              <div><span>On hand</span><strong>8</strong></div>
              <div className="operator">−</div>
              <div><span>Confirmed demand</span><strong>14</strong></div>
              <div className="operator">−</div>
              <div><span>Safety stock</span><strong>2</strong></div>
              <div className="operator">=</div>
              <div className="shortage-total"><span>Required</span><strong>8</strong></div>
            </div>

            <div className="forecast-bars">
              {[["Current stock", 8, 40], ["Forecast demand", 14, 70], ["Reorder target", 16, 80]].map(
                ([label, value, width]) => (
                  <div className="bar-row" key={String(label)}>
                    <span>{label}</span>
                    <div className="bar-track"><div style={{ width: `${width}%` }} /></div>
                    <strong>{value}</strong>
                  </div>
                ),
              )}
            </div>
          </article>

          <article className="panel workflow-card">
            <div className="panel-heading">
              <div>
                <span className="section-kicker">State-machine orchestration</span>
                <h2>Autonomous workflow</h2>
              </div>
              <span className="live-indicator"><i /> {demoStatus === "running" ? "Running" : demoStatus === "complete" ? "Complete" : demoStatus === "blocked" ? "Blocked" : "Ready"}</span>
            </div>

            <div className="timeline">
              {demoResult?.stateHistory ? demoResult.stateHistory.slice(-7).map((event) => (
                <div className={`timeline-step ${event.to === demoResult.workflowState ? "active" : "complete"}`} key={event.sequence}>
                  <div className="timeline-marker"><BadgeCheck size={18} /></div>
                  <div><strong>{event.to.replaceAll("_", " ")}</strong><span>{event.reason}</span></div>
                  <time>#{event.sequence}</time>
                </div>
              )) : displayedSteps.map((step, index) => (
                <div className={`timeline-step ${step.status}`} key={step.label}>
                  <div className="timeline-marker">
                    {step.status === "complete" ? <BadgeCheck size={18} /> : <PackageCheck size={18} />}
                  </div>
                  <div><strong>{step.label}</strong><span>{step.detail}</span></div>
                  <time>{["09:42", "09:47", "09:48", "09:49"][index]}</time>
                </div>
              ))}
            </div>

            <div className="proof-link">
              <FileCheck2 size={18} />
              <div><strong>{demoResult?.proof ? "Compliance proof generated" : "Compliance proof pending"}</strong><span>Policy PROCUREMENT-2026-08-v3</span></div>
              <ChevronRight size={18} />
            </div>
          </article>
        </section>

        <section className="panel offers-panel" id="suppliers">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">
                {labMode === "simulator" || labMode === "manager"
                  ? "Synthetic supplier result preview"
                  : "CALL-E result preview"}
              </span>
              <h2>Multilingual supplier comparison</h2>
              <p>Offers are normalized to EUR and validated against field-level evidence. This public run is not recorded live CALL-E evidence.</p>
            </div>
            <button className="secondary-button"><PhoneCall size={16} /> View evidence details</button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Supplier</th><th>Language</th><th>Available</th><th>Unit price</th>
                  <th>Normalized total</th><th>Delivery</th><th>Confidence</th><th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {displayedOffers.map((offer) => (
                  <tr className={offer.outcome === "Selected" ? "selected-row" : ""} key={offer.supplier}>
                    <td>
                      <div className="supplier-cell">
                        <span className="country-code">{offer.flag}</span>
                        <div><strong>{offer.supplier}</strong><span>{offer.country}</span></div>
                      </div>
                    </td>
                    <td>{offer.language}</td>
                    <td>{offer.quantity} units</td>
                    <td>{offer.unitPrice}</td>
                    <td><strong>{offer.normalizedTotal}</strong></td>
                    <td>{offer.delivery}</td>
                    <td><span className="confidence">{offer.confidence}%</span></td>
                    <td><StatusPill value={offer.outcome} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="content-grid lower-grid">
          <article className="panel validation-panel" id="policies">
            <div className="panel-heading">
              <div>
                <span className="section-kicker">Independent validation agent</span>
                <h2>{displayedValidation ? `${displayedValidation.checks.filter(({ status }) => status === "PASS").length} / ${displayedValidation.checks.length} policy checks passed` : "Validation awaiting workflow"}</h2>
              </div>
              <div className={`validation-score ${displayedValidation?.decision.toLowerCase() ?? "ready"}`}><ShieldCheck size={20} /> {displayedValidation?.decision ?? "READY"}</div>
            </div>
            <div className="checks-grid">
              {displayedValidation
                ? displayedValidation.checks.map((check) => (
                    <div className={`rule-check ${check.status.toLowerCase().replace("_", "-")}`} title={check.evidence} key={check.id}>
                      {check.status === "PASS" ? <BadgeCheck size={16} /> : <TriangleAlert size={16} />}
                      <span>{check.id.replaceAll("_", " ")}<small>{check.status}</small></span>
                    </div>
                  ))
                : checks.map((check) => <div key={check}><BadgeCheck size={16} /> {check}</div>)}
            </div>
          </article>

          <article className="panel order-panel">
            <div className="panel-heading">
              <div><span className="section-kicker">Execution result</span><h2>{demoResult?.managerEscalation ? "Manager escalation recorded" : demoResult?.purchaseOrder ? `Purchase order ${demoResult.purchaseOrder.purchaseOrderId}` : "No order created yet"}</h2></div>
              {demoResult?.managerEscalation ? <PhoneCall className="order-check" size={30} /> : <PackageCheck className="order-check" size={30} />}
            </div>
            {demoResult?.managerEscalation ? (
              <dl>
                <div><dt>Decision</dt><dd>{demoResult.managerEscalation.effectiveDecision.replaceAll("_", " ")}</dd></div>
                <div><dt>Evidence</dt><dd>{demoResult.managerEscalation.evidenceStatus}</dd></div>
                <div><dt>Policy changed</dt><dd>No</dd></div>
                <div><dt>Order created</dt><dd>No · synthetic or real</dd></div>
                <div><dt>Correlation</dt><dd>{demoResult.workflowId}</dd></div>
              </dl>
            ) : (
              <dl>
                <div><dt>Supplier</dt><dd>{demoResult?.purchaseOrder?.supplierName ?? "Awaiting workflow"}</dd></div>
                <div><dt>Quantity</dt><dd>{demoResult?.purchaseOrder ? `${demoResult.purchaseOrder.quantity} × ${demoResult.purchaseOrder.sku}` : "—"}</dd></div>
                <div><dt>Total value</dt><dd>{demoResult?.purchaseOrder ? `€${demoResult.purchaseOrder.totalPriceEur.toFixed(2)}` : "—"}</dd></div>
                <div><dt>Delivery</dt><dd>{demoResult?.purchaseOrder ? "27 Aug, before stockout" : "—"}</dd></div>
                <div><dt>Execution mode</dt><dd>{demoResult?.status === "ORDER_CREATED" ? "Autonomous green zone" : demoStatus === "blocked" ? "Execution blocked" : "Ready"}</dd></div>
              </dl>
            )}
            <button className="primary-button"><FileCheck2 size={17} /> Open decision proof</button>
          </article>
        </section>

        <section className="panel crypto-proof-panel" id="evidence">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Cryptographic decision evidence</span>
              <h2>Machine-verifiable decision proof</h2>
              <p>SHA-256 offer hashes · tamper-evident audit chain · ECDSA P-256 signature</p>
            </div>
            <div className={`proof-verdict ${proofVerification?.valid ? "valid" : proofVerification ? "invalid" : "pending"}`}>
              {proofVerification?.valid ? <BadgeCheck size={20} /> : <ShieldCheck size={20} />}
              <div>
                <strong>{proofVerification?.reason ?? "Run workflow to generate proof"}</strong>
                <span>{demoResult?.signedProof?.signer.mode === "ephemeral-browser-demo" ? "Ephemeral demo key · KMS-ready signer interface" : "No signature available"}</span>
              </div>
            </div>
          </div>

          <div className="proof-details">
            <div><span>Payload hash</span><code>{demoResult?.signedProof?.payloadHash ?? "—"}</code></div>
            <div><span>Audit root</span><code>{demoResult?.signedProof?.payload.auditRootHash ?? "—"}</code></div>
            <div><span>Signer key</span><code>{demoResult?.signedProof?.signer.keyId ?? "—"}</code></div>
            <div><span>Chain events</span><strong>{demoResult?.signedProof?.payload.auditChain.length ?? 0}</strong></div>
          </div>

          <div className="verification-checks">
            <span className={proofVerification?.payloadHashValid ? "pass" : ""}>Payload hash</span>
            <span className={proofVerification?.auditChainValid ? "pass" : ""}>Audit chain</span>
            <span className={proofVerification?.signatureValid ? "pass" : ""}>Digital signature</span>
          </div>

          <div className="proof-actions">
            <button className="primary-button compact" disabled={!demoResult?.signedProof} onClick={verifyOriginalProof}>
              <ShieldCheck size={17} /> Verify original proof
            </button>
            <button className="secondary-button" disabled={!demoResult?.signedProof} onClick={verifyTamperedCopy}>
              <TriangleAlert size={16} /> Tamper with decision and verify
            </button>
          </div>
          <small className="proof-disclaimer">The demo signature verifies integrity against the included session public key. Production will establish StockGuard origin through a trusted AWS KMS key. Neither mode proves that a supplier statement is true or that transcription is error-free.</small>
        </section>

        <footer>
          <span>StockGuard demo · Synthetic organizations, inventory and orders</span>
          <span>No real purchases are possible in this environment</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
