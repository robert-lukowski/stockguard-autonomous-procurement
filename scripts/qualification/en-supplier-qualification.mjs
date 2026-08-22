#!/usr/bin/env node
/**
 * Controlled English CALL-E qualification harness.
 *
 * DISABLED BY DEFAULT. Running this file with no environment set prints the
 * plan and exits without touching the network.
 *
 * Why this exists at all: without it an operator would improvise a one-off
 * script at the moment of highest risk, with no dry run, no printed plan and
 * no call ceiling. A checked-in harness with hard guards is the safer option.
 *
 * It deliberately does NOT solve the process-memory call-count problem found
 * in Phase 1 - it sidesteps it. Exactly one call may be started per
 * invocation, enforced here, in a single short-lived process an operator runs
 * by hand. That is why the caller is not deployed to Lambda.
 *
 * Never runs in CI, in tests, or during a build. It is not imported by
 * anything and has no npm script.
 *
 * Required to actually place a call, all of them, every time:
 *   QUALIFICATION_ARMED=I-UNDERSTAND-THIS-PLACES-A-REAL-CALL
 *   CALLE_API_KEY=...            (never stored in this repository)
 *   QUALIFICATION_PHONE_E164=... (never stored in this repository)
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const ARM_PHRASE = "I-UNDERSTAND-THIS-PLACES-A-REAL-CALL";

function maskPhone(value) {
  // Never print a full number, not even to a local terminal.
  return `${value.slice(0, 3)}${"•".repeat(Math.max(0, value.length - 5))}${value.slice(-2)}`;
}

const armed = process.env.QUALIFICATION_ARMED === ARM_PHRASE;
const apiKey = process.env.CALLE_API_KEY ?? "";
const phone = (process.env.QUALIFICATION_PHONE_E164 ?? "").trim();
const baseUrl = process.env.CALLE_BASE_URL ?? "https://api.heycall-e.com";
const sku = process.env.QUALIFICATION_SKU ?? "CF-220";
const quantity = process.env.QUALIFICATION_QUANTITY ?? "8";
const requiredBy = process.env.QUALIFICATION_REQUIRED_BY ?? "2026-08-28T12:00:00+02:00";

console.log(`
================================================================
  StockGuard - English CALL-E qualification harness
================================================================
  Target number      : ${phone ? maskPhone(phone) : "(not set)"}
  Expected recipient : the controlled Amazon Connect +1 number
  Spoken locale      : en-US
  Supplier persona   : EN_SUPPLIER / Ridgeline Industrial Supply
  Material           : ${sku}, ${quantity} units, required by ${requiredBy}
  CALL-E endpoint    : ${baseUrl}/v1/calls
  Calls this run     : 1 (hard maximum, enforced below)

  This harness will NOT create a purchase order. The English persona
  reports changed commercial terms, so the Policy Gateway resolves to
  REQUIRES_HUMAN by construction.
================================================================
`);

if (!armed) {
  console.log(
    "DRY RUN. QUALIFICATION_ARMED is not set to the arming phrase, so no\n" +
      "network request will be made and no call will be placed.\n\n" +
      "To arm, set all three:\n" +
      `  QUALIFICATION_ARMED=${ARM_PHRASE}\n` +
      "  CALLE_API_KEY=<key, never committed>\n" +
      "  QUALIFICATION_PHONE_E164=<the Connect +1 number, never committed>\n",
  );
  process.exit(0);
}

if (!apiKey) {
  console.error("Refusing to continue: CALLE_API_KEY is not set.");
  process.exit(1);
}
if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
  console.error("Refusing to continue: QUALIFICATION_PHONE_E164 is not valid E.164.");
  process.exit(1);
}
if (!phone.startsWith("+1")) {
  // The qualification target is the controlled US Connect number and nothing
  // else. This is the guard that stops a typo dialling a stranger.
  console.error("Refusing to continue: the qualification target must be the +1 Connect number.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("Refusing to continue: this harness requires an interactive terminal.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `Place ONE real telephone call to ${maskPhone(phone)} now? Type PLACE-CALL to confirm: `,
);
rl.close();

if (answer.trim() !== "PLACE-CALL") {
  console.log("Aborted. No call was placed.");
  process.exit(0);
}

// -- one call, and only one -------------------------------------------------
let callsStarted = 0;
function claimTheSingleCall() {
  if (callsStarted > 0) throw new Error("This harness places exactly one call per invocation");
  callsStarted += 1;
}

const schema = JSON.parse(
  readFileSync(new URL("./recipientResultSchema.json", import.meta.url), "utf8"),
);

const task = [
  "Call the approved supplier Ridgeline Industrial Supply.",
  "Immediately disclose that you are an AI procurement assistant calling for a fictional test organization.",
  "State that the call only requests availability information and cannot create a binding order.",
  "Use en-US throughout the conversation.",
  `Confirm availability of ${quantity} units of SKU ${sku} before ${requiredBy}.`,
  "Collect unit price, currency, earliest delivery, offer validity, and any changed commercial terms.",
  "Ask at least one follow-up question about the commercial terms.",
  "If the recipient opts out, stop the conversation and record the opt-out.",
  "Do not collect payment data, credentials, access codes, or unrelated personal information.",
].join(" ");

claimTheSingleCall();

const response = await fetch(`${baseUrl}/v1/calls`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `en-qualification:${new Date().toISOString().slice(0, 10)}:attempt:1`,
  },
  body: JSON.stringify({
    task,
    recipients: [{ phones: [phone], region: "US", locale: "en-US" }],
    recipient_result_schema: schema,
    metadata: {
      workflow_run_id: "en-qualification",
      supplier_id: "supplier-en-01",
      purpose: "synthetic-procurement-qualification",
      counterparty_mode: "synthetic-supplier-simulator",
    },
  }),
});

const body = await response.text();
console.log(`\nHTTP ${response.status}`);
console.log(body);
console.log(
  "\nRecord every field of this response in docs/calle-live-qualification-matrix.md.\n" +
    "Do NOT commit the phone number or the API key.",
);
