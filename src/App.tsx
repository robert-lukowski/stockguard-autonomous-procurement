import {
  ArrowDown,
  Boxes,
  FileCheck2,
  Github,
  PhoneCall,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Disclosure } from "./ui/Disclosure";
import { RuntimeBadge, RuntimeLegend } from "./ui/RuntimeBadge";
import { runtimeClassificationOrder } from "./ui/runtimeClassification";
import { JudgeWalkthrough } from "./ui/walkthrough/JudgeWalkthrough";

const pillars = [
  {
    icon: PhoneCall,
    title: "Reach the long tail by phone",
    body: "Most approved suppliers have no API and no EDI link. CALL-E is how an autonomous system reaches them at all.",
  },
  {
    icon: ShieldCheck,
    title: "Let code make the decision",
    body: "The agent gathers evidence. A deterministic Policy Gateway of thirteen checks decides whether to buy, refuse, or escalate.",
  },
  {
    icon: FileCheck2,
    title: "Leave an auditable record",
    body: "Every run produces a hash-chained audit timeline and a signed Decision Proof that fails verification if a single field changes.",
  },
];

export default function App() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="min-h-dvh">
      <a href="#walkthrough" className="sg-skip-link sg-panel px-4 py-2 text-sm">
        Skip to the judge walkthrough
      </a>

      <header className="mx-auto w-full max-w-5xl px-5 pt-10 pb-6 sm:px-8 sm:pt-16">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg border border-signal-500/40 bg-signal-500/12 text-signal-300">
            <ShieldCheck aria-hidden="true" className="size-5" />
          </span>
          <span className="text-sm font-semibold tracking-widest text-ground-300 uppercase">
            StockGuard
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-ground-700/50 px-2.5 py-1 text-[11px] text-ground-500">
            <Github aria-hidden="true" className="size-3.5" />
            CALL-E Hackathon submission
          </span>
        </div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.5, ease: [0.2, 0.7, 0.25, 1] }
          }
        >
          <h1 className="mt-8 max-w-3xl text-4xl leading-[1.08] font-semibold text-balance text-ground-50 sm:text-5xl">
            An autonomous buyer that is{" "}
            <span className="text-signal-300">allowed to say no</span>.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-pretty text-ground-400 sm:text-lg">
            StockGuard predicts nothing it cannot show its working for. It nets a
            material shortage, calls approved suppliers through CALL-E, checks
            every quoted number against what the supplier actually said, and
            refuses to buy when no offer satisfies policy — escalating to a human
            instead.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href="#walkthrough"
              className="inline-flex items-center gap-2 rounded-xl bg-signal-500 px-5 py-3 text-sm font-semibold text-ground-950 shadow-lg shadow-signal-500/25 transition-transform hover:brightness-110 active:scale-[0.98]"
            >
              Start 2-minute Judge Walkthrough
              <ArrowDown aria-hidden="true" className="size-4" />
            </a>
            <p className="text-xs text-ground-600">
              8 steps · no sign-up · nothing is dialled
            </p>
          </div>
        </motion.div>
      </header>

      <main className="mx-auto w-full max-w-5xl space-y-8 px-5 pb-20 sm:px-8">
        <JudgeWalkthrough />

        <section
          aria-labelledby="pillars-heading"
          className="grid gap-3 sm:grid-cols-3"
        >
          <h2 id="pillars-heading" className="sr-only">
            What StockGuard is for
          </h2>
          {pillars.map((pillar) => (
            <article key={pillar.title} className="sg-panel p-5">
              <pillar.icon aria-hidden="true" className="size-5 text-signal-300" />
              <h3 className="mt-3 text-sm font-semibold text-ground-100">
                {pillar.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ground-400">
                {pillar.body}
              </p>
            </article>
          ))}
        </section>

        <section aria-labelledby="runtime-heading" className="sg-panel p-5 sm:p-7">
          <h2
            id="runtime-heading"
            className="text-lg font-semibold text-ground-50"
          >
            What is real in this build
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ground-400">
            Every result in the walkthrough carries one of these five labels. Two
            of them cannot be produced by this build at all, and are shown locked
            rather than hidden.
          </p>
          <div className="mt-4">
            <RuntimeLegend ids={runtimeClassificationOrder} />
          </div>

          <div className="mt-4 space-y-3">
            <Disclosure
              label="Why no live call is available here"
              hint="safety boundary"
            >
              <p className="mb-3">
                This is a public static build. It contains no CALL-E API key, no
                backend URL, no access code and no phone number. The live
                adapters are fail-closed:{" "}
                <code className="font-mono text-ground-300">CallEApiAdapter</code>{" "}
                and{" "}
                <code className="font-mono text-ground-300">
                  CallEManagerEscalationAdapter
                </code>{" "}
                both throw{" "}
                <code className="font-mono text-ground-300">REAL_CALLS_DISABLED</code>{" "}
                before touching the network unless a server explicitly enables
                them, and{" "}
                <code className="font-mono text-ground-300">JudgeModeBackendClient</code>{" "}
                refuses to transmit anything when no backend is configured.
              </p>
              <p>
                No real calls, purchases, suppliers, organizations or production
                data are used anywhere in this project. Every company, material
                and order in the walkthrough is fictional.
              </p>
            </Disclosure>

            <Disclosure
              label="Amazon Connect, Lex V2 and Lambda"
              hint="designed, not deployed"
            >
              <p className="mb-3">
                A Lex V2 handler contract and a deterministic supplier data
                service exist in the repository and are unit-tested, so a future
                Amazon Connect deployment could expose the same three supplier
                profiles as a conversational test counterparty on one allowlisted
                number.
              </p>
              <p>
                <strong className="text-ground-200">
                  Nothing is deployed today.
                </strong>{" "}
                The repository's own read-only AWS inventory workflow reports zero
                StockGuard contact flows, zero associated Lambda functions and
                zero Lex V2 bots. The Synthetic Supplier Simulator you see in the
                walkthrough runs entirely in your browser. It is a test harness
                for demonstrating telephony safely — it is not the product's
                value, which is reaching real suppliers who have no API.
              </p>
            </Disclosure>

            <Disclosure label="Architecture" hint="ports and adapters">
              <ul className="space-y-2">
                <li>
                  <Workflow aria-hidden="true" className="mr-1.5 inline size-3.5" />
                  <code className="font-mono text-ground-300">src/domain</code> —
                  pure shortage netting, EUR normalization, the Policy Gateway and
                  offer selection. No I/O.
                </li>
                <li>
                  <PhoneCall aria-hidden="true" className="mr-1.5 inline size-3.5" />
                  <code className="font-mono text-ground-300">src/server/calle</code>{" "}
                  — the <code className="font-mono text-ground-300">SupplierCallingPort</code>{" "}
                  with a live CALL-E adapter and a mock, plus transcript-bound
                  evidence checking.
                </li>
                <li>
                  <Boxes aria-hidden="true" className="mr-1.5 inline size-3.5" />
                  <code className="font-mono text-ground-300">src/server/workflow</code>{" "}
                  — orchestration, the state machine, bounded retries, idempotency
                  and cancellation.
                </li>
                <li>
                  <FileCheck2 aria-hidden="true" className="mr-1.5 inline size-3.5" />
                  <code className="font-mono text-ground-300">src/security</code> —
                  canonical JSON, SHA-256 audit chaining and ECDSA P-256 signing
                  and verification.
                </li>
              </ul>
            </Disclosure>
          </div>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-5xl px-5 pb-12 sm:px-8">
        <div className="flex flex-wrap items-center gap-3 border-t border-ground-800/60 pt-6">
          <RuntimeBadge id="MOCK_RUNTIME" size="sm" />
          <p className="text-xs text-ground-600">
            Synthetic data only. No real calls, purchases, suppliers or
            production data are used.
          </p>
        </div>
      </footer>
    </div>
  );
}
