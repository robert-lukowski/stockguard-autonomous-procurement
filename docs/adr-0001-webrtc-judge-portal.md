# ADR 0001 — Judge Portal voice, controlled tools, and the removal of bot-to-bot PSTN

**Status:** accepted
**Date:** 2026-09-04
**Supersedes (as the MVP architecture):** the CALL-E → PSTN → Amazon Connect →
Lex → synthetic-supplier path described in
[`aws-live-supplier-runtime.md`](./aws-live-supplier-runtime.md)

---

## Context

The previous MVP put two independent voice stacks on opposite ends of a
telephone line: the external CALL-E agent placing an outbound PSTN call, and an
Amazon Connect contact flow with a Lex bot answering it as a synthetic supplier.

That arrangement proved unstable in live use. The repository's own history is
the evidence: commits `3323391`, `3dcdf52` and `8966f66` (PR #63) are all
turn-taking and barge-in mitigations applied through prompt text and a single
Lex session attribute, and `connect.tf` still carries the reasoning inline —
the greeting was split out of the Lex block because *"the first live calls
proved that playing Text while Lex gathers input permits barge-in and messy
turn-taking"*.

Three structural problems, not three bugs:

1. **Neither endpointing engine is controllable.** CALL-E decides for itself
   when the line has gone quiet; Connect and Lex decide separately. Reconciling
   them is prompt-tuning two black boxes against each other, with no
   convergence criterion and no test that can protect the result.
2. **The contact flow cannot hold a long conversation.** It is one
   `ConnectParticipantWithLexBot` block plus one bounded retry, and its default
   transition on any non-`FallbackIntent` result is `DisconnectParticipant`. A
   four-question qualification survives only if intent classification lands
   cleanly on every turn.
3. **The evidence chain may never pass.** `resultToOffer` marks a field
   `VERIFIED` only when CALL-E's excerpt is found in transcript turns labelled
   `speaker === "user"`. In a bot-to-bot call that transcript is ASR of our own
   TTS over a phone codec, and the seven checked fields are prices, quantities
   and dates — exactly what that pipeline corrupts.

Separately, the value being demonstrated was never the second bot. The synthetic
supplier is a **test harness**; the README already says so. All the instability
lived in the leg with no business value, and it made the leg we cared about
unmeasurable: a dropped call could not be attributed to CALL-E, to Lex, or to
the two engines disagreeing.

## Decision

### 1. Bot-to-bot PSTN leaves the MVP

Outbound supplier calling is no longer the spine of the demo. The CALL-E
adapter, its safety rules, its schema and its tests remain in the repository as
an **inactive experimental adapter** — the `SupplierCallingPort` abstraction is
the right shape for a future human-answered or vendor-answered supplier leg,
and deleting it would destroy a working model of that leg for no gain.

### 2. Voice becomes the human-facing interface, not the supplier-facing one

The judge speaks; the system listens. That inverts the fragile part: there is
now exactly **one** voice stack, and a human is on the other end of it — humans
handle turn-taking, interruption and repair natively, which is precisely what
two machines could not do between themselves.

Target runtime:

```
Judge Portal (browser)
  → protected backend session endpoint
  → Amazon Connect StartWebRTCContact
  → browser joins via Amazon Chime SDK
  → Connect flow
  → Lex / Lambda orchestrator
  → controlled procurement tools
  → decision, persistence, audit trail
  → CloudWatch → Amazon Managed Grafana
```

The judge needs no international PSTN call, pays no carrier cost, memorizes no
SKU and learns no script. They read a mission card and speak normally.

### 3. Supplier access is a controlled tool, not a conversation

Supplier data now arrives through `getSupplierQuote(sku, quantity)` — a typed
call returning a typed value. This is what removes the evidence problem
outright: there is no transcript to match an excerpt against, so no field can
degrade to `UNVERIFIED` because a phone codec mangled a number.

The tool boundary is narrow and validated server-side:

| Tool | Purpose |
|---|---|
| `searchInventory(query)` | resolve free text against the closed catalog |
| `getSupplierQuote(sku, quantity)` | deterministic quote with a provenance hash |
| `evaluatePurchase(quote, budget, requiredDelivery)` | decision core + mission checks |
| `createPurchaseRequest(approvedQuote, confirmation)` | the only spending operation |
| `requestHumanApproval(request)` | escalation; never creates an order |

Every state-changing call re-validates, from server-side records only: catalog
membership, SKU, quantity range, quote provenance, budget, delivery constraint,
policy result, explicit user confirmation, and replay. **No check trusts an
argument it was handed.**

### 4. The LLM manages the conversation and nothing else

A `ConversationNarrator` may reword the assistant's reply. Two independent
controls stop it inventing:

- it receives a `NarrationRequest` only — no catalog, no supplier store, no
  tool access, so it has nothing to invent *from*;
- `narrateSafely` rejects any narration containing a figure the tools did not
  produce, and falls back to the deterministic text.

This mirrors `SupplierResponseRealizer`, where Bedrock varies wording but never
facts. The default `DeterministicNarrator` uses no model at all.

Out-of-domain requests are answered, not guessed at: "pizza" returns
`OUT_OF_DOMAIN` from a closed catalog, and the assistant names the categories
it does cover. A correct refusal is **not** counted as a tool error.

### 5. A channel-independent core

`src/server/procurement/ProcurementOrchestrator` owns the whole run and has no
idea which channel it serves. A channel turns whatever it carries into text and
renders `TurnResult` back:

- `LocalTextChannel` — today; the Judge Portal and every test
- Connect WebRTC + Lex adapter — the seam in `src/server/webrtc`, not deployed
- chat / API adapters — deferred, no core change required
- a human-answered supplier leg — deferred; `SupplierCallingPort` already models it

## Preserved but inactive

Nothing was deleted for being outside the MVP.

| Component | State |
|---|---|
| `src/server/calle/**` | inactive experimental adapter; `realCallsEnabled` still false by default |
| `src/server/supplier-simulator/**` | **reused** — now invoked in-process as the Supplier Tool |
| `infrastructure/terraform/{connect,lex}.tf` | preserved, undeployed; `simulator_enabled` still defaults false |
| `modules/qualification-caller` | preserved, now created only when `var.live_caller_enabled` is true |
| `src/server/escalation/**`, `src/server/judge/**` | preserved; the manager-escalation path is unchanged |
| `src/domain/**`, `src/security/**` | **reused unchanged** — the decision core and proof chain are channel-agnostic |

## Security and cost controls

**Corrected in this change.** `modules/qualification-caller` publishes a Lambda
Function URL with `authorization_type = "NONE"`; an accepted POST places a real,
paid PSTN call. It is now created only when `var.live_caller_enabled` is
explicitly true, and that variable defaults to false. No workflow sets it.

The risk is stated where the resource is defined, and three claims that were
being made loosely are now corrected in code:

- there is **no** server-side rate limit on that endpoint;
- there is **no** reserved concurrency;
- `CallEApiAdapter.startedCallsByWorkflow` is a per-container `Map`. It does not
  survive a cold start and is not shared across concurrent invocations, so it is
  **not** a durable or global call budget. The Judge Portal previously rendered
  a "already in progress" message for an HTTP 429 the backend never returns;
  that branch is removed.

**For WebRTC, when it is built.** The browser must never receive AWS
credentials. `assertNoAwsCredentialMaterial` fails closed if a grant carries
credential-shaped fields, and `webRtcSessionControls` states the contract a real
provider must meet: single-use grants, ≤120 s lifetime, a per-judge hourly
ceiling enforced in a durable store, and no public unauthenticated endpoint.
The only provider shipped today is `DisabledVoiceSessionProvider`, which throws.

The flag is read as an exact `"true"`; `"TRUE"`, `"1"` and `"yes"` all leave it
off, so a mistyped variable cannot arm a path that starts a billable contact.

## Deferred

- Durable persistence. `InMemoryProcurementSessionStore` is per-process and is
  documented as such; the DynamoDB conditional-write pattern in
  `src/server/judge/aws/dynamo.ts` is the intended replacement.
- The protected backend session endpoint and a real `VoiceSessionProvider`.
- The Lex bot and Connect flow for the **judge-facing** conversation (the
  existing ones model a supplier, not a buyer).
- Wiring `EmbeddedMetricFormatSink` into a deployed Lambda, and the Managed
  Grafana dashboards over the resulting CloudWatch metrics.
- KMS-backed Decision Proof signing (still the one missing adapter).
- A human-answered supplier leg to settle
  [`calle-assumptions-register.md`](./calle-assumptions-register.md), if the
  outbound-vendor story is still wanted.

## Consequences

The demo now runs end to end with no telephony, no AWS call and no credential,
which means it is testable in CI for the first time. The cost is that outbound
autonomous supplier calling is demonstrated by an inactive adapter and its tests
rather than by a live call — an acceptable trade, since that live call was never
reliably demonstrable anyway.
