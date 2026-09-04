import { AwsDynamoDocument } from "../../../src/server/aws/AwsDynamoDocument";
import { DynamoProcurementSessionStore } from "../../../src/server/procurement/aws";
import {
  createLexVoiceHandler,
  type LexVoiceEvent,
  type LexVoiceResponse,
} from "../../../src/server/procurement/lexVoiceHandler";
import { EmbeddedMetricFormatSink } from "../../../src/server/procurement/metrics";
import { ProcurementOrchestrator } from "../../../src/server/procurement";

/**
 * AWS Lambda composition root for the judge-facing voice conversation.
 *
 * Wires already-tested pieces together and contains no procurement rules of its
 * own: those live in the orchestrator and the controlled tools, and duplicating
 * them here would let the deployed behaviour drift from what the test suite
 * covers.
 *
 * Deliberately absent, and each absence is a safety property:
 *   - no CALL-E credential, and no way to place a PSTN call;
 *   - no model authority over prices, availability or policy outcomes;
 *   - no supplier network access. The Supplier Tool runs in this process.
 */

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    // Fail closed at cold start rather than mishandling a live call.
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

let handler: ((event: LexVoiceEvent) => Promise<LexVoiceResponse>) | null = null;

function build(): (event: LexVoiceEvent) => Promise<LexVoiceResponse> {
  const dynamo = new AwsDynamoDocument({
    region: process.env.AWS_REGION?.trim() || undefined,
  });
  const sessions = new DynamoProcurementSessionStore(dynamo, required("PROCUREMENT_TABLE"));

  const orchestrator = new ProcurementOrchestrator({
    sessions,
    // EMF on stdout: CloudWatch extracts the metrics, so no AWS call is made
    // and no SDK client is needed on the hot path of a live conversation.
    metrics: new EmbeddedMetricFormatSink(),
    channel: "connect-webrtc",
  });

  return createLexVoiceHandler(
    { orchestrator, sessions },
    {
      enabled: process.env.VOICE_FULFILMENT_ENABLED === "true",
      allowedBotIds: list("ALLOWED_LEX_BOT_IDS"),
      // Alias NAME, not id: the alias's code hook points at this function, so
      // referencing the generated id here would create a Terraform cycle. The
      // name is chosen by us and just as precise.
      allowedAliasNames: list("ALLOWED_LEX_ALIAS_NAMES"),
      allowedLocales: list("ALLOWED_LEX_LOCALES"),
    },
  );
}

export async function lexFulfillment(event: LexVoiceEvent): Promise<LexVoiceResponse> {
  handler ??= build();
  const response = await handler(event);

  // Operational only. No transcript, no identity, no session attributes.
  console.log(
    JSON.stringify({
      event: "judge_voice_invocation",
      intent: event.sessionState.intent.name,
      localeId: event.bot.localeId,
      dialogAction: response.sessionState.dialogAction.type,
    }),
  );
  return response;
}
