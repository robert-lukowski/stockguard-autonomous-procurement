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
 * Supplier business facts remain deterministic and are produced before any
 * model call. Bedrock only realizes those facts as natural spoken English;
 * every model failure falls back to the existing deterministic message.
 *
 * Deliberately absent, and each absence is a safety property:
 *   - no CALL-E credential
 *   - no secret of any kind
 *   - no model authority over quantities, prices, dates, or commercial terms
 *
 * The supplier may vary wording, never facts.
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
import {
  BedrockSupplierResponseRealizer,
} from "../../../src/server/supplier-simulator/BedrockSupplierResponseRealizer";

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
  const bedrockTimeoutMs = Number.parseInt(
    required("BEDROCK_SUPPLIER_TIMEOUT_MS"),
    10,
  );
  if (!Number.isInteger(bedrockTimeoutMs) || bedrockTimeoutMs <= 0) {
    throw new Error("BEDROCK_SUPPLIER_TIMEOUT_MS must be a positive integer");
  }
  const responseRealizer = new BedrockSupplierResponseRealizer({
    modelId: required("BEDROCK_SUPPLIER_MODEL_ID"),
    timeoutMs: bedrockTimeoutMs,
    region: "eu-central-1",
  });

  /*
   * Alias is allowlisted by NAME, not id.
   *
   * The alias points at this Lambda through its code hook. If the Lambda also
   * had to know the AWS-generated alias id, the two resources would depend on
   * each other and Terraform would report a cycle. The alias name is chosen by
   * us and stable, so it identifies the alias just as precisely without the
   * circular reference. `aliasAllowed` still rejects everything when no
   * allowlist is configured.
   */
  return createSupplierSimulatorLexHandler(
    service,
    {
      enabled: process.env.SIMULATOR_ENABLED === "true",
      allowedBotIds: list("ALLOWED_LEX_BOT_IDS"),
      allowedAliasIds: [],
      allowedAliasNames: list("ALLOWED_LEX_ALIAS_NAMES"),
      allowedLocales: list("ALLOWED_LEX_LOCALES") as LexSimulatorLocale[],
      qualificationRfqId: QUALIFICATION_RFQ_ID,
    },
    responseRealizer,
  );
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
