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
  outcome: "Selected" | "Too late" | "Insufficient";
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
    detail: "12 of 12 machine-enforced checks passed",
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
  "No new commercial terms",
  "Evidence complete",
  "Confidence above 90%",
  "Retry policy respected",
  "Recipient consent verified",
];

function StatusPill({ value }: { value: SupplierOffer["outcome"] }) {
  return <span className={`status-pill ${value.toLowerCase().replace(" ", "-")}`}>{value}</span>;
}

function App() {
  const [autonomyEnabled, setAutonomyEnabled] = useState(true);

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
            <div className="metric-icon success"><CircleDollarSign size={19} /></div>
            <div><span>Selected order</span><strong>€336.00</strong><small>Within €500 autonomy limit</small></div>
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
                <span className="section-kicker">Live orchestration</span>
                <h2>Autonomous workflow</h2>
              </div>
              <span className="live-indicator"><i /> Live</span>
            </div>

            <div className="timeline">
              {steps.map((step, index) => (
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
              <div><strong>Compliance proof generated</strong><span>Policy PROCUREMENT-2026-08-v3</span></div>
              <ChevronRight size={18} />
            </div>
          </article>
        </section>

        <section className="panel offers-panel" id="suppliers">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">CALL-E results</span>
              <h2>Multilingual supplier comparison</h2>
              <p>Offers are normalized to EUR and validated against original-language evidence.</p>
            </div>
            <button className="secondary-button"><PhoneCall size={16} /> View call evidence</button>
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
                {offers.map((offer) => (
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
                <h2>12 / 12 policy checks passed</h2>
              </div>
              <div className="validation-score"><ShieldCheck size={20} /> PASS</div>
            </div>
            <div className="checks-grid">
              {checks.map((check) => <div key={check}><BadgeCheck size={16} /> {check}</div>)}
            </div>
          </article>

          <article className="panel order-panel">
            <div className="panel-heading">
              <div><span className="section-kicker">Execution result</span><h2>Purchase order PO-1042</h2></div>
              <PackageCheck className="order-check" size={30} />
            </div>
            <dl>
              <div><dt>Supplier</dt><dd>NordWerk Supply</dd></div>
              <div><dt>Quantity</dt><dd>8 × CF-220</dd></div>
              <div><dt>Total value</dt><dd>€336.00</dd></div>
              <div><dt>Delivery</dt><dd>27 Aug, before stockout</dd></div>
              <div><dt>Execution mode</dt><dd>Autonomous green zone</dd></div>
            </dl>
            <button className="primary-button"><FileCheck2 size={17} /> Open decision proof</button>
          </article>
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
