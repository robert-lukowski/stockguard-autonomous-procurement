import { Loader2, Lock, PhoneCall, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { WorkflowResult } from "../server/workflow";
import { RuntimeBadge } from "./RuntimeBadge";

type LiveQualificationEnvelope = {
  runtime: "LIVE_CALLE";
  liveCall: {
    callId: string | null;
    outcome: string | null;
    taskCompleted: boolean | null;
    attemptCount: number | null;
  } | null;
  workflow: WorkflowResult;
};

type Phase = "idle" | "running" | "done";

function resolveBackendUrl(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function humanError(status: number, body: unknown): string {
  if (status === 401) return "The Judge PIN was not accepted.";
  if (status === 400) return "Type PLACE-CALL exactly to confirm the live demo.";
  if (status === 429) return "A live qualification is already in progress. Try again when it finishes.";
  if (body && typeof body === "object" && "error" in body) {
    return `Live qualification failed: ${String((body as { error: unknown }).error)}`;
  }
  return `Live qualification failed with HTTP ${status}.`;
}

export function LiveQualificationPanel() {
  const backendUrl = useMemo(
    () => resolveBackendUrl(import.meta.env.VITE_QUALIFICATION_BACKEND_URL),
    [],
  );
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<LiveQualificationEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!backendUrl) {
    return (
      <section aria-labelledby="live-qualification-heading" className="sg-panel p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-2">
          <Lock aria-hidden="true" className="size-4 text-ground-500" />
          <h2 id="live-qualification-heading" className="text-lg font-semibold text-ground-100">
            Live CALL-E qualification
          </h2>
          <span className="ml-auto">
            <RuntimeBadge id="LIVE_CALLE_CALL" size="sm" />
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ground-400">
          The static walkthrough is available, but this build has no live backend URL configured.
          No telephone request can be sent from this page.
        </p>
      </section>
    );
  }

  const canRun =
    phase !== "running" && pin.trim().length > 0 && confirmation === "PLACE-CALL";

  const run = async () => {
    if (!canRun) return;
    setError(null);
    setResult(null);
    setPhase("running");

    const judgePin = pin;
    setPin("");

    try {
      const response = await fetch(backendUrl, {
        method: "POST",
        headers: {
          "X-Judge-PIN": judgePin,
          "X-Confirm": "PLACE-CALL",
        },
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // The status code still gives a useful error if the body is not JSON.
      }
      if (!response.ok) throw new Error(humanError(response.status, body));

      const envelope = body as LiveQualificationEnvelope;
      if (
        !envelope ||
        envelope.runtime !== "LIVE_CALLE" ||
        !envelope.workflow ||
        typeof envelope.workflow.status !== "string"
      ) {
        throw new Error("The live backend returned an unexpected response.");
      }
      setResult(envelope);
      setPhase("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The live qualification could not complete.");
      setPhase("idle");
    }
  };

  const rejected = result?.workflow.decision?.rejectedOffers ?? [];

  return (
    <section aria-labelledby="live-qualification-heading" className="sg-panel p-5 sm:p-7">
      <div className="flex flex-wrap items-center gap-2">
        <PhoneCall aria-hidden="true" className="size-5 text-review-300" />
        <h2 id="live-qualification-heading" className="text-lg font-semibold text-ground-50">
          Run the real CALL-E demo
        </h2>
        <span className="ml-auto">
          <RuntimeBadge id="LIVE_CALLE_CALL" size="sm" />
        </span>
      </div>

      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ground-400">
        This places one real CALL-E call to StockGuard&apos;s fixed synthetic supplier number.
        The page cannot choose another number, supplier, SKU or quantity, and it never receives the CALL-E API key.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="block text-[11px] font-medium tracking-wide text-ground-500 uppercase">
            Judge PIN
          </span>
          <input
            type="password"
            autoComplete="off"
            value={pin}
            disabled={phase === "running"}
            onChange={(event) => setPin(event.target.value)}
            className="mt-1 w-full rounded-lg border border-ground-700/50 bg-ground-950/60 px-3 py-2 font-mono text-sm text-ground-100 placeholder:text-ground-600 focus:border-signal-500/60"
            placeholder="Provided with the submission"
          />
          <span className="mt-1 block text-[11px] text-ground-600">
            Verified server-side. It is not embedded in the GitHub Pages bundle.
          </span>
        </label>

        <label className="block">
          <span className="block text-[11px] font-medium tracking-wide text-ground-500 uppercase">
            Live call confirmation
          </span>
          <input
            type="text"
            autoComplete="off"
            value={confirmation}
            disabled={phase === "running"}
            onChange={(event) => setConfirmation(event.target.value)}
            className="mt-1 w-full rounded-lg border border-ground-700/50 bg-ground-950/60 px-3 py-2 font-mono text-sm text-ground-100 placeholder:text-ground-600 focus:border-signal-500/60"
            placeholder="Type PLACE-CALL"
          />
          <span className="mt-1 block text-[11px] text-ground-600">
            The call is a fictional procurement qualification and cannot create a binding order.
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canRun}
          onClick={run}
          className="inline-flex items-center gap-2 rounded-lg border border-review-500/45 bg-review-500/12 px-4 py-2.5 text-sm font-semibold text-review-300 transition-colors hover:bg-review-500/18 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {phase === "running" ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <PhoneCall aria-hidden="true" className="size-4" />
          )}
          {phase === "running" ? "CALL-E call in progress…" : "Run Live Demo"}
        </button>
        {phase === "running" && (
          <span className="text-xs text-ground-500">
            A real conversation may take a few minutes. Keep this page open.
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-danger-500/30 bg-danger-500/8 px-3 py-2 text-sm text-danger-300">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-5 rounded-xl border border-signal-500/30 bg-signal-500/6 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-4 text-signal-300" />
            <h3 className="text-sm font-semibold text-ground-100">Live qualification result</h3>
            <span className="ml-auto font-mono text-xs text-signal-300">
              {result.workflow.status}
            </span>
          </div>

          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-ground-600">CALL-E call</dt>
              <dd className="mt-0.5 font-mono text-ground-200">
                {result.liveCall?.callId ?? "not returned"}
              </dd>
            </div>
            <div>
              <dt className="text-ground-600">Call outcome</dt>
              <dd className="mt-0.5 font-mono text-ground-200">
                {result.liveCall?.outcome ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-ground-600">Purchase order</dt>
              <dd className="mt-0.5 font-mono text-ground-200">
                {result.workflow.purchaseOrder ? "created" : "none"}
              </dd>
            </div>
          </dl>

          {rejected.length > 0 && (
            <div className="mt-4 border-t border-ground-700/40 pt-3">
              <p className="text-xs font-semibold text-ground-300">Deterministic policy result</p>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ground-400">
                {rejected.map(({ offer, validation }) => (
                  <li key={offer.offerId}>
                    {offer.supplierName}: {[
                      ...validation.failedCheckIds,
                      ...validation.humanReviewCheckIds,
                    ].join(", ") || "not compliant"}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-xs leading-relaxed text-ground-400">
            The supplier intentionally changes payment terms. StockGuard therefore stops at human escalation instead of creating an autonomous purchase order.
          </p>
        </div>
      )}
    </section>
  );
}
