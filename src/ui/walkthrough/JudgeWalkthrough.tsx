import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { calculateShortage, type ShortageForecast } from "../../domain";
import {
  buildJudgeInput,
  runJudgeEscalation,
  runJudgeSupplierPhase,
} from "../../demo/runDemoWorkflow";
import type { WorkflowInput } from "../../server/workflow";
import { verifyDecisionProof } from "../../security";
import { RuntimeBadge } from "../RuntimeBadge";
import { walkthroughSteps, totalSteps, type StepId } from "./steps";
import {
  ContactStep,
  EscalationStep,
  NonComplianceStep,
  OffersStep,
  PolicyStep,
  ProofStep,
  RfqStep,
  ShortageStep,
  type WalkthroughData,
} from "./StepBodies";

type Phase = "idle" | "running" | "done";

const initialData: WalkthroughData = {
  input: null,
  forecast: null,
  supplierResult: null,
  finalResult: null,
  managerResponse: "ATTEMPT_POLICY_OVERRIDE",
  verification: null,
  tamperVerification: null,
};

export function JudgeWalkthrough() {
  const [index, setIndex] = useState(0);
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<WalkthroughData>(initialData);
  const reduceMotion = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);

  const step = walkthroughSteps[index];
  const isComplete = completed.has(step.id);
  const canGoNext = isComplete && index < totalSteps - 1;

  /*
   * Focus management on step change.
   *
   * Focus moves to the section, not to the step heading: the heading lives
   * inside AnimatePresence and is unmounted while the next step animates in,
   * so focusing it drops focus to <body> and the arrow-key handler below
   * stops receiving events. The section persists across steps, and the
   * "Step N of 8" live region announces the change for screen readers.
   *
   * Skipped on first mount - nobody has navigated yet.
   */
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    sectionRef.current?.focus({ preventScroll: true });
  }, [index]);

  const markDone = useCallback((id: StepId) => {
    setCompleted((current) => new Set(current).add(id));
  }, []);

  // Review steps do no work, so they are complete as soon as they are reached.
  // Their only action is to move on, and the button says exactly that.
  useEffect(() => {
    if (!step.computes) markDone(step.id);
  }, [markDone, step.computes, step.id]);

  const runPrimaryAction = useCallback(async () => {
    setError(null);
    try {
      switch (step.id) {
        case "shortage": {
          const input = buildJudgeInput();
          const forecast: ShortageForecast = calculateShortage(input.inventory);
          setData((current) => ({ ...current, input, forecast }));
          break;
        }
        case "contact": {
          setPhase("running");
          const input: WorkflowInput = data.input ?? buildJudgeInput();
          const supplierResult = await runJudgeSupplierPhase(input);
          setData((current) => ({ ...current, input, supplierResult }));
          setPhase("done");
          break;
        }
        case "escalation": {
          setPhase("running");
          if (!data.input || !data.supplierResult) {
            throw new Error("Supplier phase has not run yet");
          }
          const finalResult = await runJudgeEscalation(
            data.input,
            data.supplierResult,
            data.managerResponse,
          );
          setData((current) => ({
            ...current,
            finalResult,
            verification: null,
            tamperVerification: null,
          }));
          setPhase("done");
          break;
        }
        case "proof": {
          const proof = data.finalResult?.signedProof;
          if (!proof) throw new Error("No signed proof is available");
          const verification = await verifyDecisionProof(proof);
          setData((current) => ({ ...current, verification }));
          break;
        }
        default:
          break;
      }
      markDone(step.id);
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "The step could not complete");
    }
  }, [data, markDone, step.id]);

  const tamperWithProof = useCallback(async () => {
    const proof = data.finalResult?.signedProof;
    if (!proof) return;
    const tampered = structuredClone(proof);
    tampered.payload.orderValueEur = 999_999;
    const tamperVerification = await verifyDecisionProof(tampered);
    setData((current) => ({ ...current, tamperVerification }));
  }, [data.finalResult]);

  const restart = useCallback(() => {
    setData(initialData);
    setCompleted(new Set());
    setIndex(0);
    setPhase("idle");
    setError(null);
  }, []);

  // Arrow keys move between steps that have already been unlocked.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowRight" && canGoNext) {
        event.preventDefault();
        setIndex((current) => current + 1);
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        setIndex((current) => current - 1);
      }
    },
    [canGoNext, index],
  );

  const busy = phase === "running";

  return (
    <section
      id="walkthrough"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="walkthrough-heading"
      onKeyDown={onKeyDown}
      className="sg-panel overflow-hidden focus:outline-none"
    >
      {/* progress rail */}
      <div className="border-b border-ground-700/40 px-5 py-4 sm:px-7">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p
            className="text-xs font-semibold tracking-widest text-signal-300 uppercase"
            aria-live="polite"
          >
            Step {index + 1} of {totalSteps}
          </p>
          <RuntimeBadge id={step.runtime} size="sm" />
          {step.secondaryRuntime && (
            <RuntimeBadge id={step.secondaryRuntime} size="sm" />
          )}
          <button
            type="button"
            onClick={restart}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ground-500 transition-colors hover:text-ground-200"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Restart
          </button>
        </div>

        <ol className="mt-3 flex gap-1" aria-label="Walkthrough progress">
          {walkthroughSteps.map((entry, position) => {
            const done = completed.has(entry.id);
            const current = position === index;
            const reachable = done || position <= index;
            return (
              <li key={entry.id} className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={current ? "step" : undefined}
                  onClick={() => setIndex(position)}
                  title={`${position + 1}. ${entry.title}`}
                  className={`group block w-full rounded-full transition-colors ${
                    reachable ? "cursor-pointer" : "cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`block h-1 rounded-full ${
                      current
                        ? "bg-signal-400"
                        : done
                          ? "bg-signal-500/50"
                          : "bg-ground-700/60"
                    }`}
                  />
                  <span className="sr-only">
                    {position + 1}. {entry.title}
                    {done ? " (done)" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* step body */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step.id}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 0.22, ease: [0.2, 0.7, 0.25, 1] }
          }
          className="px-5 py-6 sm:px-7"
        >
          <h2
            id="walkthrough-heading"
            className="text-xl font-semibold text-balance text-ground-50 sm:text-2xl"
          >
            {step.question}
          </h2>
          <p className="mt-1 text-sm text-ground-500">
            {index + 1}. {step.title}
          </p>

          <div className="mt-5">
            {step.id === "shortage" && <ShortageStep {...data} />}
            {step.id === "rfq" && <RfqStep {...data} />}
            {step.id === "contact" && <ContactStep {...data} />}
            {step.id === "offers" && <OffersStep {...data} />}
            {step.id === "policy" && <PolicyStep {...data} />}
            {step.id === "noncompliance" && <NonComplianceStep {...data} />}
            {step.id === "escalation" && (
              <EscalationStep
                {...data}
                onSelectResponse={(managerResponse) => {
                  // Changing the answer invalidates the recorded call, the
                  // signed proof and both verification results.
                  setData((current) => ({
                    ...current,
                    managerResponse,
                    finalResult: null,
                    verification: null,
                    tamperVerification: null,
                  }));
                  setCompleted((current) => {
                    const next = new Set(current);
                    next.delete("escalation");
                    next.delete("proof");
                    return next;
                  });
                }}
              />
            )}
            {step.id === "proof" && <ProofStep {...data} onTamper={tamperWithProof} />}
          </div>

          {/* what happened / why it matters, only once the step has run */}
          {isComplete && (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-ground-700/40 bg-ground-950/30 px-4 py-3">
                <h3 className="text-[11px] font-semibold tracking-widest text-ground-500 uppercase">
                  What happened?
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ground-300">
                  {step.whatHappened}
                </p>
              </div>
              <div className="rounded-lg border border-signal-500/25 bg-signal-500/6 px-4 py-3">
                <h3 className="text-[11px] font-semibold tracking-widest text-signal-300 uppercase">
                  Why it matters
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ground-300">
                  {step.whyItMatters}
                </p>
              </div>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-block-500/40 bg-block-500/10 px-4 py-2.5 text-sm text-block-300"
            >
              {error}
            </p>
          )}
        </motion.div>
      </AnimatePresence>

      {/* actions */}
      <div className="flex flex-wrap items-center gap-3 border-t border-ground-700/40 px-5 py-4 sm:px-7">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(current - 1, 0))}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-ground-400 transition-colors hover:text-ground-100 disabled:pointer-events-none disabled:opacity-40"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </button>

        {/*
          Exactly one primary action is visible at a time: run the step, or -
          once it has run - move to the next one.
        */}
        {step.computes && !isComplete ? (
          <button
            type="button"
            onClick={runPrimaryAction}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2.5 text-sm font-semibold text-ground-950 shadow-lg shadow-signal-500/20 transition-transform hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60"
          >
            {busy && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            {busy ? "Working…" : step.action}
          </button>
        ) : (
          <>
            {step.computes && (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-pass-500/40 bg-pass-500/10 px-3 py-2 text-sm text-pass-300">
                <Check aria-hidden="true" className="size-4" />
                {step.actionDone}
              </span>
            )}
            {canGoNext && (
              <button
                type="button"
                onClick={() => setIndex((current) => current + 1)}
                className="inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2.5 text-sm font-semibold text-ground-950 shadow-lg shadow-signal-500/20 transition-transform hover:brightness-110 active:scale-[0.98]"
              >
                {index === totalSteps - 2 ? "Final step" : "Next step"}
                <ArrowRight aria-hidden="true" className="size-4" />
              </button>
            )}
          </>
        )}

        {/* Re-running the escalation after changing the manager's answer. */}
        {step.id === "escalation" && isComplete && (
          <button
            type="button"
            onClick={runPrimaryAction}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ground-600/50 px-3 py-2 text-sm text-ground-300 transition-colors hover:border-signal-500/60 hover:text-signal-300 disabled:opacity-50"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Call again with another answer
          </button>
        )}

        <p className="ml-auto hidden items-center gap-1.5 text-xs text-ground-600 lg:flex">
          <CircleHelp aria-hidden="true" className="size-3.5" />
          Use ← and → to move between steps
        </p>
      </div>
    </section>
  );
}
