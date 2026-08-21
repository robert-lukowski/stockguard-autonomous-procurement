import {
  AlertTriangle,
  CircleSlash,
  FileSignature,
  Languages,
  PhoneOff,
  Quote,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ShortageForecast, PolicyCheck, NormalizedOffer } from "../../domain";
import type { WorkflowInput, WorkflowResult } from "../../server/workflow";
import type { MockManagerResponse } from "../../server/escalation";
import type { ProofVerification } from "../../security";
import { CodeBlock, Disclosure } from "../Disclosure";
import { LiveJudgeModePanel } from "./LiveJudgeModePanel";
import { decisionTone } from "../runtimeClassification";

export type WalkthroughData = {
  input: WorkflowInput | null;
  forecast: ShortageForecast | null;
  supplierResult: WorkflowResult | null;
  finalResult: WorkflowResult | null;
  managerResponse: MockManagerResponse;
  verification: ProofVerification | null;
  tamperVerification: ProofVerification | null;
};

/* ---------- small shared pieces ---------- */

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-ground-700/40 bg-ground-950/40 px-3 py-2.5">
      <dt className="text-[11px] font-medium tracking-wide text-ground-600 uppercase">
        {label}
      </dt>
      <dd
        className={`mt-0.5 font-mono break-all ${
          emphasis
            ? "text-base text-signal-300 sm:text-lg"
            : "text-sm text-ground-200"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusChip({ status }: { status: PolicyCheck["status"] }) {
  const tone = decisionTone[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase ${tone.tone}`}
    >
      {tone.label}
    </span>
  );
}

function EmptyPrompt({ children }: { children: string }) {
  return (
    <p className="rounded-lg border border-dashed border-ground-700/60 bg-ground-950/30 px-4 py-6 text-center text-sm text-ground-600">
      {children}
    </p>
  );
}

function shortDate(value: string | null): string {
  if (!value) return "not provided";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "not provided";
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function maskedPhone(value: string): string {
  return `${value.slice(0, 5)}••••${value.slice(-2)}`;
}

/* ---------- 1. shortage ---------- */

export function ShortageStep({ input, forecast }: WalkthroughData) {
  if (!input || !forecast) {
    return (
      <EmptyPrompt>
        Run shortage detection to net demand against stock on hand.
      </EmptyPrompt>
    );
  }

  const { inventory } = input;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Material" value={inventory.sku} />
        <Stat label="On hand" value={`${inventory.onHand} units`} />
        <Stat label="Inbound confirmed" value={`${inventory.inboundConfirmed} units`} />
        <Stat label="Confirmed demand" value={`${inventory.confirmedDemand} units`} />
        <Stat label="Safety stock" value={`${inventory.safetyStock} units`} />
        <Stat label="Projected available" value={`${forecast.projectedAvailable} units`} />
      </dl>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-review-500/35 bg-review-500/8 px-4 py-3">
        <AlertTriangle aria-hidden="true" className="size-5 shrink-0 text-review-300" />
        <p className="text-sm text-ground-200">
          Shortage of{" "}
          <strong className="font-mono text-review-300">
            {forecast.requiredQuantity} units
          </strong>{" "}
          of {forecast.sku}, projected to bite on{" "}
          <strong className="text-ground-100">{shortDate(forecast.stockoutAt)}</strong>.
        </p>
      </div>

      <Disclosure label="How the shortage is calculated" hint="src/domain/forecast.ts">
        <p className="mb-3">
          This is deterministic netting, not a statistical forecast:{" "}
          <code className="font-mono text-ground-300">
            required = max(0, demand + safetyStock − (onHand + inbound))
          </code>
          . The stockout date is supplied by the inventory position rather than
          predicted by StockGuard.
        </p>
        <CodeBlock>{JSON.stringify(forecast, null, 2)}</CodeBlock>
      </Disclosure>
    </div>
  );
}

/* ---------- 2. RFQ ---------- */

export function RfqStep({ input, forecast }: WalkthroughData) {
  if (!input || !forecast) {
    return <EmptyPrompt>Prepare the RFQ to see the call authorization.</EmptyPrompt>;
  }

  const { callAuthorization, procurementPolicy } = input;

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {input.suppliers.map((supplier) => (
          <li
            key={supplier.supplierId}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ground-700/40 bg-ground-950/40 px-3 py-2.5"
          >
            <span className="min-w-40 grow text-sm font-medium text-ground-100">
              {supplier.supplierName}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-ground-400">
              <Languages aria-hidden="true" className="size-3.5" />
              {supplier.locale}
            </span>
            <span className="font-mono text-xs text-ground-500">
              {maskedPhone(supplier.phoneE164)}
            </span>
            {supplier.syntheticRouting && (
              <span className="rounded border border-signal-500/35 bg-signal-500/10 px-1.5 py-0.5 font-mono text-[11px] text-signal-300">
                routing {supplier.syntheticRouting.routingCode}
              </span>
            )}
          </li>
        ))}
      </ul>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Quantity requested" value={`${forecast.requiredQuantity} units`} />
        <Stat label="Max calls" value={String(callAuthorization.maximumCalls)} />
        <Stat label="Unit price ceiling" value={`€${procurementPolicy.unitPriceCeilingEur}`} />
        <Stat label="Autonomy limit" value={`€${procurementPolicy.autonomousOrderLimitEur}`} />
      </dl>

      <Disclosure
        label="Call authorization and safety boundary"
        hint="src/server/calle/safety.ts"
      >
        <p className="mb-3">
          <code className="font-mono text-ground-300">validateCallAuthorization</code>{" "}
          runs before any call is started and throws on workflow mismatch, expiry,
          an unlisted supplier, an unlisted number, missing consent, or a call
          limit outside 1–5. Synthetic routing additionally requires the
          allowlisted test number and a matching profile.
        </p>
        <CodeBlock>
          {JSON.stringify(
            {
              ...callAuthorization,
              allowedPhoneNumbers:
                callAuthorization.allowedPhoneNumbers.map(maskedPhone),
            },
            null,
            2,
          )}
        </CodeBlock>
      </Disclosure>
    </div>
  );
}

/* ---------- 3. contact ---------- */

export function ContactStep({ supplierResult }: WalkthroughData) {
  if (!supplierResult) {
    return <EmptyPrompt>Contact the approved suppliers to collect offers.</EmptyPrompt>;
  }

  const calls = supplierResult.auditTimeline.filter(
    (event) => event.type === "CALL_COMPLETED",
  );

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {calls.map((call) => (
          <li
            key={call.sequence}
            className="rounded-lg border border-ground-700/40 bg-ground-950/40 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="grow text-sm text-ground-100">{call.summary}</span>
              <span className="rounded border border-ground-600/50 bg-ground-800/60 px-1.5 py-0.5 font-mono text-[11px] text-ground-300">
                {String(call.evidence.outcome ?? "—")}
              </span>
              {typeof call.evidence.confidence === "number" && (
                <span className="font-mono text-xs text-ground-500">
                  {Math.round(call.evidence.confidence * 100)}% confidence
                </span>
              )}
            </div>
            <p className="mt-1 font-mono text-[11px] text-ground-600">
              counterparty: {String(call.evidence.counterpartyMode ?? "—")}
              {call.evidence.rfqId ? ` · ${String(call.evidence.rfqId)}` : ""}
            </p>
          </li>
        ))}
      </ul>

      <Disclosure
        label="What a live CALL-E call would do here"
        hint="src/server/calle/CallEApiAdapter.ts"
      >
        <p className="mb-3">
          The live adapter posts to{" "}
          <code className="font-mono text-ground-300">POST /v1/calls</code> with a
          task brief, a <code className="font-mono text-ground-300">recipient_result_schema</code>,
          an idempotency key and a webhook URL. The brief opens with an AI
          disclosure, states that the call cannot create a binding order, and
          forbids collecting payment data or credentials.
        </p>
        <p>
          It is disabled in this build:{" "}
          <code className="font-mono text-ground-300">realCallsEnabled</code>{" "}
          defaults to false and the adapter throws{" "}
          <code className="font-mono text-ground-300">REAL_CALLS_DISABLED</code>{" "}
          before any network access. No API key exists in this bundle.
        </p>
      </Disclosure>
    </div>
  );
}

/* ---------- 4. offers + evidence ---------- */

function OfferCard({ offer }: { offer: NormalizedOffer }) {
  const fields = Object.entries(offer.evidenceByField);

  /*
   * Truthful evidence labelling.
   *
   * The verification mechanism is identical for mock and live runs, but the
   * INPUT is not: in this build the excerpts come from the Synthetic Supplier
   * Simulator, not from a real recipient. A verified excerpt must therefore
   * never render the same chip a real CALL-E transcript match would earn.
   */
  const evidenceLabel = (verified: boolean) =>
    verified ? "simulated transcript" : "unverified";

  return (
    <li className="rounded-xl border border-ground-700/40 bg-ground-950/40 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-ground-100">{offer.supplierName}</h4>
        <span className="text-xs text-ground-500">{offer.language}</span>
        <span className="ml-auto font-mono text-sm text-signal-300">
          €{offer.totalPriceEur.toFixed(2)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Available" value={`${offer.availableQuantity}`} />
        <Stat
          label="Unit price"
          value={`${offer.unitPrice.toFixed(2)} ${offer.currency}`}
        />
        <Stat label="Delivery" value={shortDate(offer.deliveryAt)} />
        <Stat label="Valid until" value={shortDate(offer.offerValidUntil)} />
      </dl>

      {fields.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {fields.map(([field, evidence]) => (
            <li key={field} className="flex items-start gap-2 text-xs">
              <Quote
                aria-hidden="true"
                className={`mt-0.5 size-3 shrink-0 ${
                  evidence.verified ? "text-pass-300" : "text-review-300"
                }`}
              />
              <span className="font-mono text-ground-600">{field}</span>
              <span className="grow text-ground-400 italic">
                “{evidence.excerpt}”
              </span>
              <span
                className={`shrink-0 rounded border px-1 py-px text-[10px] font-semibold uppercase ${
                  evidence.verified
                    ? "border-signal-500/40 bg-signal-500/10 text-signal-300"
                    : decisionTone.REQUIRES_HUMAN.tone
                }`}
              >
                {evidenceLabel(evidence.verified)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function OffersStep({ supplierResult }: WalkthroughData) {
  const decision = supplierResult?.decision;
  if (!decision) {
    return <EmptyPrompt>Offers appear once the supplier calls complete.</EmptyPrompt>;
  }

  const offers = [
    ...(decision.selectedOffer ? [decision.selectedOffer] : []),
    ...decision.rejectedOffers.map(({ offer }) => offer),
  ];

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-signal-500/25 bg-signal-500/6 px-4 py-2.5 text-xs leading-relaxed text-ground-300">
        The excerpts below were produced by the Synthetic Supplier Simulator, so
        they are labelled{" "}
        <span className="font-semibold text-signal-300">simulated transcript</span>
        , never <span className="font-mono">transcript</span>. The verification
        step is identical to the live path — only the input differs.
      </p>

      <ul className="space-y-3">
        {offers.map((offer) => (
          <OfferCard key={offer.offerId} offer={offer} />
        ))}
      </ul>

      <Disclosure
        label="How evidence is bound to the transcript"
        hint="src/server/calle/runtime.ts"
      >
        <p className="mb-3">
          CALL-E is asked to return, for every commercial field, the exact words
          the recipient spoke. StockGuard then runs{" "}
          <code className="font-mono text-ground-300">evidenceAppearsInTranscript</code>{" "}
          against the caller-side transcript turns. An excerpt that does not
          appear is marked{" "}
          <code className="font-mono text-ground-300">structured-result</code>{" "}
          instead of <code className="font-mono text-ground-300">transcript</code>,
          and the Policy Gateway then treats that field as unverified.
        </p>
        <p>
          In this run the excerpts come from the Synthetic Supplier Simulator, so
          they are synthetic English text — not a recording of a real person.
        </p>
      </Disclosure>
    </div>
  );
}

/* ---------- 5. policy gateway ---------- */

export function PolicyStep({ supplierResult }: WalkthroughData) {
  const decision = supplierResult?.decision;
  if (!decision) {
    return <EmptyPrompt>Run the Policy Gateway to evaluate every offer.</EmptyPrompt>;
  }

  const evaluated = [
    ...(decision.selectedOffer && decision.validation
      ? [{ offer: decision.selectedOffer, validation: decision.validation }]
      : []),
    ...decision.rejectedOffers,
  ];

  return (
    <div className="space-y-4">
      {evaluated.map(({ offer, validation }) => (
        <section
          key={offer.offerId}
          className="rounded-xl border border-ground-700/40 bg-ground-950/40 p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="grow text-sm font-semibold text-ground-100">
              {offer.supplierName}
            </h4>
            <StatusChip
              status={validation.decision === "BLOCK" ? "FAIL" : validation.decision}
            />
          </div>

          <ul className="mt-3 grid gap-1">
            {validation.checks.map((check) => (
              <li
                key={check.id}
                className="flex items-start gap-2 border-b border-ground-800/50 py-1 text-xs last:border-0"
              >
                <StatusChip status={check.status} />
                <span className="min-w-52 font-mono text-ground-500">{check.id}</span>
                <span className="grow text-ground-400">{check.evidence}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Disclosure label="The rule set" hint="src/domain/policy.ts">
        <p className="mb-3">
          Thirteen checks, all pure functions over the normalized offer, the
          shortage forecast and the procurement policy. Six of them are
          evidence-aware: if the supporting field is not{" "}
          <code className="font-mono text-ground-300">VERIFIED</code>, the check
          returns needs-human rather than pass, regardless of the value.
        </p>
        <CodeBlock>
          {JSON.stringify(
            evaluated.map(({ offer, validation }) => ({
              supplier: offer.supplierName,
              decision: validation.decision,
              failed: validation.failedCheckIds,
              requiresHuman: validation.humanReviewCheckIds,
            })),
            null,
            2,
          )}
        </CodeBlock>
      </Disclosure>
    </div>
  );
}

/* ---------- 6. non-compliance ---------- */

export function NonComplianceStep({ supplierResult }: WalkthroughData) {
  const decision = supplierResult?.decision;
  if (!decision) {
    return <EmptyPrompt>Complete the Policy Gateway step first.</EmptyPrompt>;
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {decision.rejectedOffers.map(({ offer, validation }) => {
          const blocking = [
            ...validation.checks.filter((check) => check.status === "FAIL"),
            ...validation.checks.filter((check) => check.status === "REQUIRES_HUMAN"),
          ];
          return (
            <li
              key={offer.offerId}
              className="rounded-lg border border-ground-700/40 bg-ground-950/40 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <CircleSlash aria-hidden="true" className="size-4 text-block-300" />
                <h4 className="text-sm font-semibold text-ground-100">
                  {offer.supplierName}
                </h4>
              </div>
              <ul className="mt-2 space-y-1">
                {blocking.map((check) => (
                  <li key={check.id} className="flex items-start gap-2 text-xs">
                    <StatusChip status={check.status} />
                    <span className="text-ground-400">{check.evidence}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      <div className="flex items-start gap-3 rounded-lg border border-block-500/35 bg-block-500/8 px-4 py-3">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-block-300" />
        <div className="text-sm text-ground-200">
          <p className="font-medium">No purchase order was created.</p>
          <p className="mt-0.5 text-ground-400">{decision.reason}</p>
        </div>
      </div>
    </div>
  );
}

/* ---------- 7. escalation ---------- */

const managerOptions: Array<{
  value: MockManagerResponse;
  label: string;
  detail: string;
}> = [
  {
    value: "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
    label: "Acknowledge and start human sourcing",
    detail: "A bounded operational instruction. Recorded as given.",
  },
  {
    value: "RETRY_APPROVED_SUPPLIERS_LATER",
    label: "Retry approved suppliers later",
    detail: "Records a callback time. No automatic retry in this version.",
  },
  {
    value: "ATTEMPT_POLICY_OVERRIDE",
    label: "“Increase the budget and buy anyway”",
    detail: "The override attempt. Watch what the guardrail does with it.",
  },
  {
    value: "DECLINE_ESCALATION",
    label: "Decline and opt out",
    detail: "Stops the call and suppresses further contact this session.",
  },
];

export function EscalationStep({
  managerResponse,
  finalResult,
  onSelectResponse,
}: WalkthroughData & { onSelectResponse: (value: MockManagerResponse) => void }) {
  const record = finalResult?.managerEscalation;
  const overridden =
    record && record.rawDecision !== record.effectiveDecision;

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs font-medium tracking-wide text-ground-500 uppercase">
          What does the manager say on the call?
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {managerOptions.map((option) => {
            const active = managerResponse === option.value;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                  active
                    ? "border-signal-500/60 bg-signal-500/10"
                    : "border-ground-700/40 bg-ground-950/40 hover:border-ground-600/60"
                }`}
              >
                <input
                  type="radio"
                  name="manager-response"
                  value={option.value}
                  checked={active}
                  onChange={() => onSelectResponse(option.value)}
                  className="mt-1 size-3.5 shrink-0 accent-[oklch(0.79_0.12_202)]"
                />
                <span>
                  <span className="block text-sm text-ground-100">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-ground-500">
                    {option.detail}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {!record && (
        <EmptyPrompt>
          Place the escalation call to record a bounded manager decision.
        </EmptyPrompt>
      )}

      {record && (
        <div className="space-y-3">
          <dl className="grid gap-2 sm:grid-cols-2">
            <Stat label="Spoken decision" value={record.rawDecision} />
            <Stat label="Effective decision" value={record.effectiveDecision} emphasis />
          </dl>

          {record.evidenceExcerpt && (
            <p className="rounded-lg border border-ground-700/40 bg-ground-950/40 px-3 py-2 text-xs text-ground-400 italic">
              <Quote aria-hidden="true" className="mr-1.5 inline size-3" />
              {record.evidenceExcerpt}
              <span className="ml-2 rounded border border-review-500/40 bg-review-500/10 px-1 py-px text-[10px] font-semibold text-review-300 not-italic uppercase">
                simulated response
              </span>
            </p>
          )}

          {overridden && (
            <div className="flex items-start gap-3 rounded-lg border border-review-500/40 bg-review-500/8 px-4 py-3">
              <ShieldCheck
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-review-300"
              />
              <div className="text-sm text-ground-200">
                <p className="font-medium">
                  The spoken request was converted, not obeyed.
                </p>
                <p className="mt-0.5 text-ground-400">
                  Restricted actions requested:{" "}
                  <span className="font-mono text-review-300">
                    {record.restrictedActionsRequested.join(", ") || "none"}
                  </span>
                  . Policy changed:{" "}
                  <span className="font-mono">{String(record.policyChanged)}</span>.
                  Order created:{" "}
                  <span className="font-mono">{String(record.orderCreated)}</span>.
                </p>
              </div>
            </div>
          )}

          {record.outcome !== "ANSWERED" && (
            <p className="flex items-center gap-2 text-xs text-ground-500">
              <PhoneOff aria-hidden="true" className="size-3.5" />
              Call outcome: {record.outcome}
            </p>
          )}
        </div>
      )}

      {/*
        Live Judge Mode is a separate, controlled option. The mock path above
        is unchanged and remains the primary public demo.
      */}
      <div className="border-t border-ground-700/40 pt-4">
        <p className="mb-3 text-xs text-ground-500">
          Everything above runs in mock. If you have a judge access code, you
          can instead take this call yourself:
        </p>
        <LiveJudgeModePanel />
      </div>

      <Disclosure
        label="How the guardrail works"
        hint="src/server/escalation/validateManagerEscalation.ts"
      >
        <p className="mb-3">
          <code className="font-mono text-ground-300">createManagerEscalationRecord</code>{" "}
          discards the response entirely unless the call was answered, the schema
          validated, and the decision excerpt was verified against the
          transcript. It then computes the effective decision in code: an opt-out
          becomes <code className="font-mono text-ground-300">DECLINE_ESCALATION</code>,
          and any restricted action becomes{" "}
          <code className="font-mono text-ground-300">
            REQUIRES_AUTHENTICATED_HUMAN_APPROVAL
          </code>
          .
        </p>
        <p>
          <code className="font-mono text-ground-300">policyChanged</code> and{" "}
          <code className="font-mono text-ground-300">orderCreated</code> are typed
          as the literal <code className="font-mono text-ground-300">false</code>,
          so a voice-driven override cannot be represented in the type system at
          all.
        </p>
      </Disclosure>
    </div>
  );
}

/* ---------- 8. proof ---------- */

function VerificationRow({
  label,
  verification,
}: {
  label: string;
  verification: ProofVerification | null;
}) {
  if (!verification) return null;
  const good = verification.valid;
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
        good
          ? "border-pass-500/40 bg-pass-500/8"
          : "border-block-500/40 bg-block-500/8"
      }`}
    >
      {good ? (
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-pass-300" />
      ) : (
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-block-300" />
      )}
      <div className="text-sm">
        <p className="font-medium text-ground-100">{label}</p>
        <p className={`mt-0.5 ${good ? "text-pass-300" : "text-block-300"}`}>
          {verification.reason}
        </p>
        <p className="mt-1 font-mono text-[11px] text-ground-500">
          payload {verification.payloadHashValid ? "ok" : "modified"} · signature{" "}
          {verification.signatureValid ? "ok" : "invalid"} · audit chain{" "}
          {verification.auditChainValid ? "intact" : "broken"}
        </p>
      </div>
    </div>
  );
}

export function ProofStep({
  finalResult,
  verification,
  tamperVerification,
  onTamper,
}: WalkthroughData & { onTamper: () => void }) {
  const proof = finalResult?.signedProof;
  if (!proof) {
    return <EmptyPrompt>Complete the escalation step to sign a Decision Proof.</EmptyPrompt>;
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Schema" value={proof.payload.schemaVersion.replace("stockguard-", "")} />
        <Stat label="Algorithm" value={proof.signatureAlgorithm} />
        <Stat label="Audit events" value={String(proof.payload.auditChain.length)} />
        <Stat label="Policy" value={proof.payload.policyVersion} />
      </dl>

      <p className="font-mono text-[11px] break-all text-ground-600">
        payload hash {proof.payloadHash}
      </p>

      <VerificationRow label="Original record" verification={verification} />
      <VerificationRow label="Tampered copy" verification={tamperVerification} />

      <button
        type="button"
        onClick={onTamper}
        className="inline-flex items-center gap-2 rounded-lg border border-block-500/40 bg-block-500/10 px-3.5 py-2 text-sm font-medium text-block-300 transition-colors hover:bg-block-500/20"
      >
        <Sparkles aria-hidden="true" className="size-4" />
        Tamper with the order value and re-verify
      </button>

      <div className="flex items-start gap-3 rounded-lg border border-ground-700/45 bg-ground-950/40 px-4 py-3">
        <FileSignature
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-ground-500"
        />
        <p className="text-xs leading-relaxed text-ground-400">
          This proof establishes <strong className="text-ground-200">integrity</strong>{" "}
          and tamper-evidence only. The demo signer generates an ephemeral
          keypair in your browser and ships the public key inside the proof, so
          it does <strong className="text-ground-200">not</strong> establish signer
          identity. A production deployment would sign with a managed KMS key,
          which is not deployed. It never proves that a supplier or manager
          statement was true, and it is not a legal signature.
        </p>
      </div>

      <Disclosure label="Signed payload" hint="src/security/decisionProof.ts">
        <CodeBlock>{JSON.stringify(proof.payload, null, 2)}</CodeBlock>
      </Disclosure>
    </div>
  );
}
