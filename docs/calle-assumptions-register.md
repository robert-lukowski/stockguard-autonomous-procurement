# CALL-E assumptions register

Every row is something the code currently **assumes**. None has been observed
against the real CALL-E API.

> **Status 2026-09-04.** Still true, and now deferred rather than pending. Live
> calls did reach the Amazon Connect side (see
> [ADR 0001](./adr-0001-webrtc-judge-portal.md) for the evidence), but nothing
> was recorded about the CALL-E API itself, so every row below stands
> unverified. Bot-to-bot PSTN has left the MVP; this register becomes live work
> again only if outbound supplier calling is revived.

**These must not be "fixed" by guessing.** Changing an assumption without an
observation just replaces one guess with another, and loses the record that it
was ever uncertain. Fill the Observed column from a controlled run, then
change the code.

| # | Assumption | Where | Status |
|---|---|---|---|
| 1 | Transcript speaker label for the callee is `"user"` | `runtime.ts` `userTranscript()` | **LIVE QUALIFICATION REQUIRED** |
| 2 | Result lives at `recipients[0].structured_result` | `runtime.ts` `recipientStructuredResult()` | **LIVE QUALIFICATION REQUIRED** |
| 3 | CALL-E returns `fieldEvidence` when the schema asks for it | `resultSchema.ts`, `mapTask()` | **LIVE QUALIFICATION REQUIRED** |
| 4 | Failure text contains `no_answer` / `voicemail` / `timeout` | `runtime.ts` `callFailureText()`, `taskOutcome()` | **LIVE QUALIFICATION REQUIRED** |
| 5 | Webhook is delivered to `webhook_url` on terminal states | `CallEApiAdapter`, `JudgeWebhookService` | **LIVE QUALIFICATION REQUIRED** |
| 6 | CALL-E does not sign webhooks, so read-back is the origin check | `CallEWebhookAuthenticityVerifier` | **LIVE QUALIFICATION REQUIRED** |
| 7 | Read-back snapshot is canonically identical to `event.data` | same | **LIVE QUALIFICATION REQUIRED** |
| 8 | `Idempotency-Key` deduplicates a repeated create | `CallEApiAdapter` | **LIVE QUALIFICATION REQUIRED** |
| 9 | No-answer reaches a terminal state rather than hanging | `taskOutcome()` | **LIVE QUALIFICATION REQUIRED** |
| 10 | Voicemail is distinguishable from an answered call | `taskOutcome()` | **LIVE QUALIFICATION REQUIRED** |
| 11 | Mid-call disconnect produces a terminal status | `taskStatus()` | **LIVE QUALIFICATION REQUIRED** |
| 12 | 15s + 3×5s is enough to reach terminal | `defaultCallExecutionPolicy` | **LIVE QUALIFICATION REQUIRED** |
| 13 | A `+1` recipient may hold a `de-DE` / `fr-FR` conversation | Architecture B | **QUALIFICATION RISK** |
| 14 | CALL-E can speak a six-digit code Lex will recognise | Architecture B routing | **LIVE QUALIFICATION REQUIRED** |
| 15 | `completion_confidence` is `{score,label}` or a number | `mapTask()` | **LIVE QUALIFICATION REQUIRED** |
| 16 | International calling charges EU→US are acceptable | cost | **LIVE QUALIFICATION REQUIRED** |

## Why 1, 3 and 4 come first

1 and 3 feed the same mechanism. `resultToOffer` marks a field `VERIFIED` only
when `fieldEvidence[field].verified` is true, and that is set only when the
excerpt is found among transcript turns whose speaker is `"user"`. If either
assumption is wrong, **every** field is `UNVERIFIED`, every evidence-aware
check returns `REQUIRES_HUMAN`, and no offer can ever pass. The product would
appear to work and never approve anything.

4 decides whether retry happens at all. `taskOutcome()` matches substrings; if
CALL-E uses numeric codes or different wording, every failure collapses to
`INCOMPLETE`, which is not retryable, and the bounded retry never fires.

## 13 is a risk, not a blocker

The design does **not** require more phone numbers. All three personas use the
same controlled +1 number, because a supplier's nationality is a scenario
attribute rather than a PSTN destination.

If CALL-E turns out to constrain locale by destination, that is an empirical
finding to record and then design around — not a reason to buy `+49`, `+33` or
`+48` numbers in advance, and not a reason to hold up the English
qualification.

## Rules

- Do not edit code to match a guess about a row here.
- Fill the observation in `calle-live-qualification-matrix.md` first.
- Then change the code, and move the row out of this register in the same
  commit that cites the observation.
