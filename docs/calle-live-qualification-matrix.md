# CALL-E live qualification matrix

Observation sheet for the **first real English call**. Every value below is
still a blank.

> **Clarified 2026-09-04.** "Nothing has been observed" was too strong: live
> calls did reach the Connect flow, and their turn-taking behaviour drove the
> fixes in PR #63. What is true is narrower and still worth stating — **no row
> of this matrix has been filled in**, so no CALL-E API shape, no failure-code
> vocabulary and no policy-path result is recorded anywhere. Section B
> (Connect / Lex / Lambda) is the part live behaviour touched.
>
> Filling this matrix is deferred: bot-to-bot PSTN left the MVP in
> [ADR 0001](./adr-0001-webrtc-judge-portal.md).

> **Never commit** an API key, a full phone number, or a raw transcript
> containing one. Mask numbers as `+1•••••••42`.

---

## Run header

| Field | Value |
|---|---|
| Date / time (UTC) | |
| Operator | |
| Commit SHA under test | |
| `simulator_enabled` | |
| Recording enabled | |
| Target (masked) | |
| Spoken locale | `en-US` |

---

## A. CALL-E

| # | Observation | Expected | Actual | Pass |
|---|---|---|---|---|
| A1 | Request accepted | HTTP 2xx | | |
| A2 | Call id returned | `call_id` or `id` present | | |
| A3 | Initial status value | one of `queued` / `in_progress` | | |
| A4 | Status values seen over the call | | | |
| A5 | Terminal status value | `completed` | | |
| A6 | Time to terminal | — | | |
| A7 | `recipients[]` present | array, length 1 | | |
| A8 | Result location | `recipients[0].structured_result` | | |
| A9 | `structured_result` matches our schema | all 12 required fields | | |
| A10 | **`fieldEvidence` returned** | object with 7 excerpt strings | | |
| A11 | `completion_confidence` shape | `{score,label}` or number | | |
| A12 | `evidence[]` shape | string array | | |
| A13 | `attempts[]` present | array | | |
| A14 | `transcript_turns` shape | `{speaker,text,offset_seconds}` | | |
| A15 | **Speaker label values** | `"user"` / `"bot"` / other | | |
| A16 | Failure fields on failure | `failure_code` / `failure_message` | | |
| A17 | Actual failure code vocabulary | — | | |
| A18 | `webhook_url` delivered | POST received | | |
| A19 | Webhook envelope shape | `{id,type,data}` | | |
| A20 | Webhook header carrying event id | `call-e-event-id` | | |
| A21 | Read-back snapshot equals `event.data` | canonically identical | | |

**A10 and A15 are existential.** If `fieldEvidence` is not returned, or the
speaker label is not what `userTranscript()` filters on, every field degrades
to `UNVERIFIED` and no offer can ever pass the Policy Gateway. Check these
two first.

---

## B. Amazon Connect / Lex / Lambda

| # | Observation | Expected | Actual | Pass |
|---|---|---|---|---|
| B1 | Contact reached the StockGuard flow | contact record exists | | |
| B2 | Voice/TTS audible and intelligible | Neural, Joanna | | |
| B3 | Lex invoked | flow log shows Lex block | | |
| B4 | Lambda invoked | CloudWatch log line present | | |
| B5 | Intent progression observed | `GetSupplierQuote` → … | | |
| B6 | Intent recognition failures | FallbackIntent count | | |
| B6a | **Multi-turn attributes survive** | turn 2 not `RFQ_CONTEXT_INVALID` | | |
| B7 | Lambda errors | none | | |
| B8 | Lambda duration / cold start | — | | |
| B9 | `simulatorStatus` in session attributes | `SYNTHETIC` | | |
| B10 | Disconnect reason | clean | | |
| B11 | Recording written to S3 | object present | | |
| B12 | Barge-in / interruption behaviour | — | | |

---

## C. StockGuard policy path

| # | Observation | Expected | Actual | Pass |
|---|---|---|---|---|
| C1 | Extracted `availableQuantity` | | | |
| C2 | Extracted `unitPrice` / `currency` | | | |
| C3 | Extracted `deliveryAt` | | | |
| C4 | Extracted `offerValidUntil` | | | |
| C5 | Extracted `commercialTermsChanged` | `true` | | |
| C6 | `evidenceAppearsInTranscript` accepts real excerpts | true for each field | | |
| C7 | Fields marked `VERIFIED` | 7 of 7 | | |
| C8 | Rule trace produced | 13 checks | | |
| C9 | `commercial_terms_unchanged` | `REQUIRES_HUMAN` | | |
| C10 | **Final Policy Gateway decision** | `HUMAN_EXCEPTION_REQUIRED` | | |
| C11 | Purchase order created | **must be none** | | |

C10/C11 are the safety assertion: a successful qualification must NOT produce
an order.

---

## D. Failure-path qualification

Run only after the success path is understood. One at a time.

| # | Scenario | How to induce | Observed CALL-E outcome | Our mapped `outcome` |
|---|---|---|---|---|
| D1 | No answer | number that does not answer | | |
| D2 | Voicemail | number with voicemail | | |
| D3 | Mid-call disconnect | hang up during the call | | |
| D4 | Timeout | flow that never responds | | |
| D5 | Incomplete answer | Lambda returns partial data | | |
| D6 | Malformed structured result | `simulator_enabled=false` | | |
| D7 | Duplicate webhook | replay the same event id | | |
| D8 | Retry after retryable outcome | — | | |
| D9 | Polling reaches terminal within budget | 15s + 3×5s | | |

**D9 validates the Step 0 cadence.** If a real call needs longer than
`initialPollDelayMs + maximumPolls × pollIntervalMs`, re-derive those numbers
from what was measured here — that is exactly what they are placeholders for.

---

## E. Multilingual, only after A–C pass

The destination is the **same +1 number** in all three. Nationality is a
scenario attribute, not a PSTN destination.

| Test | Destination | Locale | Result |
|---|---|---|---|
| A | +1 Connect number | `en-US` | |
| B | +1 Connect number | `de-DE` | |
| C | +1 Connect number | `fr-FR` | |

If B or C fails because CALL-E enforces a destination/locale relationship,
**record the empirical result and then revisit the design**. Until observed,
this is a qualification risk, not a blocker, and it does not justify buying
another phone number.
