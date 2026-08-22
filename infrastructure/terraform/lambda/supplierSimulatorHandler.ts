/**
 * AWS Lambda composition root for the synthetic supplier simulator.
 *
 * Architecture A only — the first controlled English qualification.
 *
 * This file wires existing, already-tested pieces together. It contains no
 * supplier business rules: those live in `SupplierSimulatorService` and
 * `createSupplierSimulatorLexHandler`, and duplicating them here would let the
 * deployed behaviour drift away from what the test suite covers.
 *
 * Deliberately absent, and each absence is a safety property:
 *   - no AWS SDK: nothing to call, so no IAM beyond CloudWatch Logs
 *   - no outbound HTTP
 *   - no CALL-E credential
 *   - no secret of any kind
 *   - no randomness, no clock-dependent branching, no generative model
 *
 * CALL-E is the conversational AI under test. A supplier that improvised would
 * make the test prove nothing.
 */
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  createSupplierSimulatorLexHandler,
  syntheticSupplierProfiles,
  type LexSimulatorLocale,
  type LexV2Event,
  type LexV2Response,
  type SyntheticRfq,
} from "../../../src/server/supplier-simulator";

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    // Fail closed at cold start rather than answering a real call wrongly.
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function list(name: string): string[] {
  return required(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The single fixed RFQ for Architecture A.
 *
 * This is qualification state, NOT an RFQ store. It lives in module scope, so
 * it is per-container and disappears on cold start — acceptable only because
 * it is a constant that every container derives identically, never something
 * a caller mutates. Architecture B replaces this with DynamoDB, where RFQs are
 * created per run, expire, and must survive across invocations.
 */
const QUALIFICATION_RFQ_ID = "RFQ-EN-QUALIFICATION";

function qualificationRfq(sku: string, requestedQuantity: number): SyntheticRfq {
  const profile = syntheticSupplierProfiles.EN_SUPPLIER;
  return {
    runId: "en-qualification",
    rfqId: QUALIFICATION_RFQ_ID,
    routingCode: "000001",
    profileId: profile.profileId,
    datasetVersion: profile.datasetVersion,
    sku,
    requestedQuantity,
    requiredBy: required("QUALIFICATION_REQUIRED_BY"),
    // Far future: the qualification RFQ must not expire mid-call.
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

let handler: ((event: LexV2Event) => Promise<LexV2Response>) | null = null;

function buildHandler(): (event: LexV2Event) => Promise<LexV2Response> {
  const sku = required("QUALIFICATION_SKU");
  const quantity = Number.parseInt(required("QUALIFICATION_QUANTITY"), 10);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("QUALIFICATION_QUANTITY must be a positive integer");
  }

  const service = new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(
      [syntheticSupplierProfiles.EN_SUPPLIER],
      [qualificationRfq(sku, quantity)],
    ),
  );

  return createSupplierSimulatorLexHandler(service, {
    enabled: process.env.SIMULATOR_ENABLED === "true",
    allowedBotIds: list("ALLOWED_LEX_BOT_IDS"),
    allowedAliasIds: list("ALLOWED_LEX_ALIAS_IDS"),
    allowedLocales: list("ALLOWED_LEX_LOCALES") as LexSimulatorLocale[],
    qualificationRfqId: QUALIFICATION_RFQ_ID,
  });
}

export async function lexFulfillment(event: LexV2Event): Promise<LexV2Response> {
  handler ??= buildHandler();
  const response = await handler(event);

  // Operational only. No transcript, no phone number, no session attributes.
  console.log(
    JSON.stringify({
      event: "supplier_simulator_invocation",
      intent: event.sessionState.intent.name,
      localeId: event.bot.localeId,
      dialogAction: response.sessionState.dialogAction.type,
      simulatorStatus: response.sessionState.sessionAttributes.simulatorStatus,
    }),
  );
  return response;
}

/** Exported for tests; production uses `lexFulfillment`. */
export const __testing = { QUALIFICATION_RFQ_ID, qualificationRfq };
