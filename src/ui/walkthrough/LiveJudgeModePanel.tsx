import { Loader2, Lock, PhoneCall, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupportedCallLocale } from "../../server/calle";
import {
  JudgeModeBackendClient,
  type JudgeRunStatus,
  type JudgeSession,
} from "../../server/judge";
import {
  deriveLocaleFromPhone,
  isSupportedJudgePhone,
  resolveJudgeBackendUrl,
  supportedJudgeLocales,
} from "../judgeModeConfig";
import { classificationForBackendRuntime } from "../runtimeClassification";
import { RuntimeBadge } from "../RuntimeBadge";
import { Disclosure } from "../Disclosure";
import {
  authorizeJudgeSession,
  liveJudgeErrorMessage,
  livePollPolicy,
  runLiveManagerCall,
} from "./liveJudgeSession";

type Phase = "IDLE" | "AUTHORIZING" | "AUTHORIZED" | "CALLING" | "TERMINAL";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium tracking-wide text-ground-500 uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ground-600">{hint}</span>}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-lg border border-ground-700/50 bg-ground-950/60 px-3 py-2 font-mono text-sm text-ground-100 placeholder:text-ground-600 focus:border-signal-500/60";

export function LiveJudgeModePanel({ backendUrl }: { backendUrl?: string }) {
  const resolved = useMemo(
    () => (backendUrl === undefined ? resolveJudgeBackendUrl() : resolveJudgeBackendUrl(backendUrl)),
    [backendUrl],
  );

  const [accessCode, setAccessCode] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [localeOverride, setLocaleOverride] = useState<SupportedCallLocale | "">("");
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [session, setSession] = useState<JudgeSession | null>(null);
  const [status, setStatus] = useState<JudgeRunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  // Polling must stop when this panel goes away.
  const cancelRef = useRef({ aborted: false });
  useEffect(() => {
    const signal = cancelRef.current;
    return () => {
      signal.aborted = true;
    };
  }, []);

  const derivedLocale = deriveLocaleFromPhone(phoneE164);
  const locale: SupportedCallLocale | null = localeOverride || derivedLocale;
  const client = useMemo(
    () => new JudgeModeBackendClient(resolved ? { baseUrl: resolved } : {}),
    [resolved],
  );

  const authorize = useCallback(async () => {
    setError(null);
    setPhase("AUTHORIZING");
    try {
      const created = await authorizeJudgeSession({ client }, accessCode);
      setSession(created);
      // The plaintext code has served its purpose; drop it from memory.
      setAccessCode("");
      setPhase("AUTHORIZED");
    } catch (caught) {
      setError(liveJudgeErrorMessage(caught));
      setPhase("IDLE");
    }
  }, [accessCode, client]);

  const placeCall = useCallback(async () => {
    if (!session || !locale) return;
    setError(null);
    setTimedOut(false);
    setPhase("CALLING");
    try {
      const result = await runLiveManagerCall(
        { client, signal: cancelRef.current },
        session,
        { phoneE164: phoneE164.trim(), locale },
        setStatus,
      );
      if (cancelRef.current.aborted) return;
      setTimedOut(result.timedOut);
      setPhase(result.status?.terminal ? "TERMINAL" : "AUTHORIZED");
    } catch (caught) {
      setError(liveJudgeErrorMessage(caught));
      setPhase("AUTHORIZED");
    }
  }, [client, locale, phoneE164, session]);

  /* ---------- locked ---------- */
  if (!resolved) {
    return (
      <section
        aria-labelledby="live-judge-heading"
        className="rounded-xl border border-ground-700/45 bg-ground-950/50 p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Lock aria-hidden="true" className="size-4 text-ground-500" />
          <h4 id="live-judge-heading" className="text-sm font-semibold text-ground-200">
            Live Judge Mode
          </h4>
          <span className="ml-auto">
            <RuntimeBadge id="LIVE_CALLE_CALL" size="sm" />
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ground-400">
          This public build ships no backend URL, so Live Judge Mode is locked
          and no network request can be made from this page. The walkthrough
          above is unaffected and remains fully usable — it is the intended
          demo. Nothing here is dialled.
        </p>
      </section>
    );
  }

  /* ---------- available ---------- */
  const canAuthorize = accessCode.trim().length > 0 && phase === "IDLE";
  const canCall =
    phase === "AUTHORIZED" &&
    consent &&
    isSupportedJudgePhone(phoneE164) &&
    locale !== null;
  const manager = status?.manager ?? null;
  const overridden = manager && manager.rawDecision !== manager.effectiveDecision;

  return (
    <section
      aria-labelledby="live-judge-heading"
      className="rounded-xl border border-review-500/35 bg-review-500/6 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <PhoneCall aria-hidden="true" className="size-4 text-review-300" />
        <h4 id="live-judge-heading" className="text-sm font-semibold text-ground-100">
          Live Judge Mode
        </h4>
        {/* Only ever the runtime the backend reported for this run. */}
        {status && (
          <span className="ml-auto">
            <RuntimeBadge
              id={classificationForBackendRuntime(status.runtime)}
              size="sm"
            />
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1 text-xs leading-relaxed text-ground-400">
        <li>· One call per session. The session is short-lived and single-use.</li>
        <li>· You act as the duty procurement manager in a fictional scenario.</li>
        <li>· No real purchase order can be created, whatever is said on the call.</li>
        <li>· A restricted request cannot override policy — it is recorded and converted.</li>
        <li>· Your number is sent to the backend only after you consent, and is never stored here.</li>
      </ul>

      {!session && (
        <div className="mt-4 space-y-3">
          <Field label="Judge access code" hint="Verified server-side. Never present in this bundle.">
            <input
              type="password"
              autoComplete="off"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              className={inputClass}
              placeholder="Provided with the submission"
            />
          </Field>
          <button
            type="button"
            disabled={!canAuthorize}
            onClick={authorize}
            className="inline-flex items-center gap-2 rounded-lg border border-review-500/45 bg-review-500/12 px-3.5 py-2 text-sm font-medium text-review-300 disabled:opacity-45"
          >
            {phase === "AUTHORIZING" && (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            )}
            {phase === "AUTHORIZING" ? "Authorizing…" : "Authorize Judge session"}
          </button>
        </div>
      )}

      {session && (
        <div className="mt-4 space-y-3">
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-ground-600">Session runtime</dt>
              <dd className="font-mono text-ground-200">{session.mode}</dd>
            </div>
            <div>
              <dt className="text-ground-600">Remaining calls</dt>
              <dd className="font-mono text-ground-200">{session.remainingCalls}</dd>
            </div>
            <div>
              <dt className="text-ground-600">Session expires</dt>
              <dd className="font-mono text-ground-200">
                {new Date(session.expiresAt).toLocaleTimeString("en-GB")}
              </dd>
            </div>
          </dl>

          <Field
            label="Your phone number"
            hint="E.164 only. Supported: +1, +33, +44, +48, +49."
          >
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phoneE164}
              onChange={(event) => setPhoneE164(event.target.value)}
              className={inputClass}
              placeholder="+48500100200"
            />
          </Field>

          <Field label="Conversation locale" hint="Derived from your calling code; override if you prefer.">
            <select
              value={localeOverride || derivedLocale || ""}
              onChange={(event) =>
                setLocaleOverride(event.target.value as SupportedCallLocale)
              }
              className={inputClass}
            >
              {supportedJudgeLocales.map((value) => (
                <option key={value} value={value}>
                  {value}
                  {value === derivedLocale ? " (derived)" : ""}
                </option>
              ))}
            </select>
          </Field>

          <label className="flex items-start gap-2 text-xs text-ground-300">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[oklch(0.79_0.15_78)]"
            />
            I consent to receiving one demonstration call from StockGuard via CALL-E.
          </label>

          <button
            type="button"
            disabled={!canCall}
            onClick={placeCall}
            className="inline-flex items-center gap-2 rounded-lg bg-review-500 px-4 py-2.5 text-sm font-semibold text-ground-950 disabled:opacity-45"
          >
            {phase === "CALLING" && (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            )}
            {phase === "CALLING" ? "Calling…" : "Call me via CALL-E as duty manager"}
          </button>
        </div>
      )}

      {status && !manager && (
        <p aria-live="polite" className="mt-3 font-mono text-xs text-ground-400">
          state: {status.state}
        </p>
      )}

      {timedOut && (
        <p role="status" className="mt-3 text-xs text-review-300">
          Stopped polling after {livePollPolicy.timeoutMs / 1000}s without a
          terminal result. No further calls are made.
        </p>
      )}

      {manager && (
        <div className="mt-4 space-y-2 border-t border-ground-700/40 pt-3">
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-ground-600">Spoken decision</dt>
              <dd className="font-mono break-all text-ground-200">{manager.rawDecision}</dd>
            </div>
            <div>
              <dt className="text-ground-600">Effective decision</dt>
              <dd className="font-mono break-all text-review-300">
                {manager.effectiveDecision}
              </dd>
            </div>
          </dl>
          {manager.evidenceExcerpt && (
            <p className="text-xs text-ground-400 italic">“{manager.evidenceExcerpt}”</p>
          )}
          <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ground-500">
            <span>policyChanged: {String(manager.policyChanged)}</span>
            <span>orderCreated: {String(manager.orderCreated)}</span>
            <span>evidence: {manager.evidenceStatus}</span>
          </p>
          {overridden && (
            <p className="flex items-start gap-2 rounded-lg border border-review-500/40 bg-review-500/10 px-3 py-2 text-xs text-ground-200">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-review-300" />
              The spoken request was converted, not obeyed. Restricted actions:{" "}
              <span className="font-mono">
                {manager.restrictedActionsRequested.join(", ") || "none"}
              </span>
              .
            </p>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-block-500/40 bg-block-500/10 px-3 py-2 text-xs text-block-300"
        >
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="mt-3">
        <Disclosure label="What the backend enforces" hint="src/server/judge/backend">
          <p className="mb-2">
            The access code is verified server-side with PBKDF2-SHA256 and a
            constant-time comparison. The session token is stored only as a
            SHA-256 hash, expires in 15 minutes, and permits exactly one call
            through an atomic conditional claim.
          </p>
          <p>
            The run is minted by the backend, not this page: the browser cannot
            assert workflow eligibility or supply rejected offers. Your number
            is validated against a country allowlist and persisted only as a
            hash. A global kill switch and call budget can refuse the call
            outright. The supplier phase in this scenario is synthetic even when
            the manager call is live.
          </p>
        </Disclosure>
      </div>
    </section>
  );
}
