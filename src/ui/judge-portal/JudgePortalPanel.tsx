import {
  CheckCircle2,
  CircleSlash,
  ClipboardList,
  Loader2,
  Mic,
  ShieldQuestion,
  Wrench,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  LocalTextChannel,
  ProcurementOrchestrator,
  judgeMissions,
  type ConfirmationResult,
  type RunReport,
  type TurnResult,
} from "../../server/procurement";
import { RuntimeBadge } from "../RuntimeBadge";
import { resolveJudgePortalConfig } from "./judgePortalConfig";

type Phase = "idle" | "running" | "awaiting-decision" | "done";

const outcomeTone: Record<string, string> = {
  PURCHASE_REQUEST_CREATED: "border-signal-500/45 bg-signal-500/12 text-signal-300",
  HUMAN_APPROVAL_REQUESTED: "border-proof-500/40 bg-proof-500/10 text-proof-300",
  REJECTED_BY_POLICY: "border-ground-600/60 bg-ground-800/70 text-ground-200",
  DECLINED_BY_USER: "border-ground-600/60 bg-ground-800/70 text-ground-200",
  OUT_OF_DOMAIN: "border-ground-600/60 bg-ground-800/70 text-ground-200",
  TOOL_FAILURE: "border-ground-600/60 bg-ground-800/70 text-ground-200",
};

function checkTone(status: string): string {
  if (status === "PASS") return "text-signal-300";
  if (status === "FAIL") return "text-ground-200";
  return "text-proof-300";
}

export function JudgePortalPanel() {
  const config = useMemo(() => resolveJudgePortalConfig(), []);
  const [missionId, setMissionId] = useState(judgeMissions[0].missionId);
  const [utterance, setUtterance] = useState(judgeMissions[0].exampleUtterance);
  const [phase, setPhase] = useState<Phase>("idle");
  const [turn, setTurn] = useState<TurnResult | null>(null);
  const [decision, setDecision] = useState<ConfirmationResult | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<LocalTextChannel | null>(null);
  const sessionRef = useRef<string | null>(null);

  const mission = judgeMissions.find((entry) => entry.missionId === missionId)!;

  const reset = () => {
    setTurn(null);
    setDecision(null);
    setReport(null);
    setError(null);
    channelRef.current = null;
    sessionRef.current = null;
    setPhase("idle");
  };

  const run = async () => {
    setError(null);
    setDecision(null);
    setReport(null);
    setPhase("running");
    try {
      /*
       * A fresh orchestrator per run keeps the demo reproducible: session
       * state, metrics and the audit chain all start empty, so a judge who
       * re-runs the mission sees exactly the first run again.
       */
      const orchestrator = new ProcurementOrchestrator({ channel: "judge-portal" });
      const channel = new LocalTextChannel(orchestrator);
      channelRef.current = channel;

      const { sessionId } = await channel.start(missionId);
      sessionRef.current = sessionId;

      const result = await channel.say(sessionId, utterance);
      setTurn(result);

      if (result.evaluation?.outcome === "ACCEPTED") {
        setPhase("awaiting-decision");
        return;
      }
      if (result.evaluation?.outcome === "HUMAN_REVIEW_REQUIRED") {
        setPhase("awaiting-decision");
        return;
      }
      setReport(await channel.report(sessionId));
      setPhase("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The procurement run failed.");
      setPhase("idle");
    }
  };

  const decide = async (accepted: boolean) => {
    const channel = channelRef.current;
    const sessionId = sessionRef.current;
    if (!channel || !sessionId || !turn?.evaluation) return;
    setPhase("running");
    try {
      const result =
        turn.evaluation.outcome === "HUMAN_REVIEW_REQUIRED"
          ? await channel.escalate(sessionId, turn.evaluation.evaluationId)
          : await channel.decide(
              sessionId,
              turn.evaluation.evaluationId,
              turn.confirmationToken ?? "",
              accepted,
            );
      setDecision(result);
      setReport(await channel.report(sessionId));
      setPhase("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision could not be recorded.");
      setPhase("awaiting-decision");
    }
  };

  const finalOutcome = decision?.outcome ?? turn?.outcome ?? null;

  return (
    <section aria-labelledby="judge-portal-heading" className="sg-panel p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardList aria-hidden="true" className="size-4 text-signal-300" />
        <h2 id="judge-portal-heading" className="text-lg font-semibold text-ground-100">
          Judge Portal — procurement mission
        </h2>
        <span className="ml-auto">
          <RuntimeBadge id="SYNTHETIC_SUPPLIER_SIMULATOR" size="sm" />
        </span>
      </div>

      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ground-400">
        Read the mission, then say what you need in your own words. No phone
        call is placed and no AWS service is contacted: the request runs through
        the same controlled tools, the same thirteen-check Policy Gateway and
        the same audit chain the voice channel will use.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-ground-700/50 px-3 py-2 text-xs text-ground-500">
        <Mic aria-hidden="true" className="size-3.5" />
        <span>{config.voiceStatus}</span>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="rounded-xl border border-signal-500/30 bg-signal-500/[0.06] p-4">
          <p className="text-[11px] font-semibold tracking-widest text-signal-300 uppercase">
            Your mission
          </p>
          <h3 className="mt-2 text-sm font-semibold text-ground-100">{mission.title}</h3>
          <dl className="mt-3 space-y-1.5 text-sm">
            {[
              ["Product", mission.productLabel],
              ["Quantity", String(mission.requestedQuantity)],
              ["Maximum budget", `${mission.maximumBudget.toLocaleString("en-US")} ${mission.budgetCurrency}`],
              ["Required delivery", `within ${mission.requiredDeliveryDays} days`],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-ground-500">{label}</dt>
                <dd className="text-right font-medium text-ground-200">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-ground-400">Mission</span>
            <select
              value={missionId}
              disabled={phase === "running"}
              onChange={(event) => {
                const next = judgeMissions.find((entry) => entry.missionId === event.target.value)!;
                setMissionId(next.missionId);
                setUtterance(next.exampleUtterance);
                reset();
              }}
              className="mt-1 w-full rounded-lg border border-ground-700/60 bg-ground-900/60 px-3 py-2 text-sm text-ground-100"
            >
              {judgeMissions.map((entry) => (
                <option key={entry.missionId} value={entry.missionId}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="text-ground-400">What do you need?</span>
            <textarea
              value={utterance}
              rows={2}
              disabled={phase === "running"}
              onChange={(event) => setUtterance(event.target.value)}
              className="mt-1 w-full rounded-lg border border-ground-700/60 bg-ground-900/60 px-3 py-2 text-sm text-ground-100"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={run}
              disabled={phase === "running" || utterance.trim().length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-ground-950 disabled:opacity-50"
            >
              {phase === "running" ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              Run the mission
            </button>
            {phase !== "idle" ? (
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-ground-700/60 px-4 py-2 text-sm text-ground-300"
              >
                Reset
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-sm text-ground-200">
          {error}
        </p>
      ) : null}

      {turn ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-ground-700/50 p-4">
            <p className="text-[11px] font-semibold tracking-widest text-ground-500 uppercase">
              What the system understood
            </p>
            <dl className="mt-2 grid gap-1.5 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-ground-500">Product query</dt>
                <dd className="text-ground-200">{turn.resolved?.productQuery || "—"}</dd>
              </div>
              <div>
                <dt className="text-ground-500">Quantity</dt>
                <dd className="text-ground-200">{turn.resolved?.quantity ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-ground-500">Required within</dt>
                <dd className="text-ground-200">{turn.resolved?.requiredWithinDays ?? "—"} days</dd>
              </div>
            </dl>
            {turn.resolved && turn.resolved.assumed.length > 0 ? (
              <p className="mt-2 text-xs text-ground-500">
                Taken from the mission because you did not say it:{" "}
                {turn.resolved.assumed.join(", ")}.
              </p>
            ) : null}
            {turn.search ? (
              <p className="mt-2 text-xs text-ground-500">
                Catalog resolution: <span className="text-ground-300">{turn.search.status}</span>
                {turn.search.matches.length > 0
                  ? ` → ${turn.search.matches.map((match) => `${match.name} (${match.sku})`).join(", ")}`
                  : ""}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-ground-700/50 p-4">
            <p className="flex items-center gap-2 text-[11px] font-semibold tracking-widest text-ground-500 uppercase">
              <Wrench aria-hidden="true" className="size-3.5" />
              Controlled tools invoked
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {turn.toolInvocations.map((invocation, index) => (
                <li key={`${invocation.tool}-${index}`} className="flex items-center gap-2">
                  {invocation.ok ? (
                    <CheckCircle2 aria-hidden="true" className="size-3.5 text-signal-300" />
                  ) : (
                    <CircleSlash aria-hidden="true" className="size-3.5 text-ground-400" />
                  )}
                  <code className="text-ground-200">{invocation.tool}</code>
                  <span className="text-ground-500">{invocation.summary}</span>
                </li>
              ))}
            </ul>
            {turn.quote ? (
              <p className="mt-3 text-xs text-ground-500">
                Quote {turn.quote.quoteId} · {turn.quote.unitPrice.toFixed(2)}{" "}
                {turn.quote.currency}/unit · delivery {turn.quote.deliveryAt.slice(0, 10)} ·
                provenance {turn.quote.provenanceHash.slice(0, 12)}…
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-ground-700/50 p-4">
            <p className="text-[11px] font-semibold tracking-widest text-ground-500 uppercase">
              Policy outcome
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ground-300">{turn.message}</p>
            {turn.evaluation ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-ground-500">
                  {turn.evaluation.checks.length} policy checks
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {turn.evaluation.checks.map((entry) => (
                    <li key={entry.id} className="flex gap-2">
                      <span className={`w-32 shrink-0 font-medium ${checkTone(entry.status)}`}>
                        {entry.status}
                      </span>
                      <code className="text-ground-300">{entry.id}</code>
                      <span className="text-ground-500">{entry.evidence}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>

          {phase === "awaiting-decision" && turn.evaluation ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-signal-500/30 bg-signal-500/[0.06] p-4">
              {turn.evaluation.outcome === "HUMAN_REVIEW_REQUIRED" ? (
                <>
                  <ShieldQuestion aria-hidden="true" className="size-4 text-proof-300" />
                  <p className="text-sm text-ground-300">
                    Policy will not decide this autonomously.
                  </p>
                  <button
                    type="button"
                    onClick={() => decide(false)}
                    className="ml-auto rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-ground-950"
                  >
                    Raise human approval request
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm text-ground-300">
                    Create the purchase request?
                  </p>
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={() => decide(false)}
                      className="rounded-lg border border-ground-700/60 px-4 py-2 text-sm text-ground-300"
                    >
                      No
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(true)}
                      className="rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-ground-950"
                    >
                      Yes, create it
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {finalOutcome ? (
            <div
              className={`rounded-xl border p-4 ${outcomeTone[finalOutcome] ?? outcomeTone.REJECTED_BY_POLICY}`}
            >
              <p className="text-[11px] font-semibold tracking-widest uppercase">Final decision</p>
              <p className="mt-1 text-sm font-semibold">{finalOutcome.replace(/_/g, " ")}</p>
              {decision ? (
                <p className="mt-1 text-sm opacity-90">{decision.message}</p>
              ) : null}
            </div>
          ) : null}

          {report ? (
            <div className="rounded-xl border border-ground-700/50 p-4">
              <p className="text-[11px] font-semibold tracking-widest text-ground-500 uppercase">
                Audit evidence
              </p>
              <p className="mt-2 text-xs text-ground-500">
                {report.audit.chain.length} hash-chained events · root{" "}
                <code className="text-ground-300">{report.audit.rootHash.slice(0, 16)}…</code>
                {report.durationMs !== null ? ` · ${report.durationMs} ms` : ""}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-ground-500">
                  Audit trail and emitted metrics
                </summary>
                <ol className="mt-2 space-y-1 text-xs">
                  {report.audit.chain.map((link) => (
                    <li key={link.sequence} className="flex gap-2">
                      <span className="w-6 shrink-0 text-ground-600">{link.sequence}</span>
                      <code className="text-ground-300">{link.payload.type}</code>
                      <span className="text-ground-600">{link.hash.slice(0, 10)}…</span>
                    </li>
                  ))}
                </ol>
                <ul className="mt-3 space-y-1 text-xs">
                  {report.metrics.map((metric, index) => (
                    <li key={`${metric.name}-${index}`} className="text-ground-500">
                      <code className="text-ground-300">{metric.name}</code> = {metric.value}{" "}
                      {metric.unit}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
