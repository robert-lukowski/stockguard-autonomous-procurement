import { defaultMission, findMission } from "./missions";
import type { ProcurementOrchestrator } from "./ProcurementOrchestrator";
import type { ProcurementSessionStore } from "./sessionStore";

/**
 * Lex V2 fulfilment for the judge-facing voice conversation.
 *
 * The bridge between speech and the channel-independent core. It owns no
 * procurement logic: it maps a Lex turn onto an orchestrator call and turns the
 * result back into something Polly can say.
 *
 * Two properties matter more than anything else here.
 *
 * FIRST, the spoken reply contains only values the tools produced. The
 * orchestrator's message is already built from the check trace and the quote,
 * and this handler never composes a number of its own — so a figure the judge
 * hears is a figure a tool returned.
 *
 * SECOND, the confirmation token never leaves the server. It lives in a Lex
 * session attribute, so an "acceptance" the judge did not give cannot be
 * fabricated by anything the microphone picked up: `ConfirmPurchase` can only
 * confirm the evaluation this session actually produced.
 */

export type LexVoiceEvent = {
  sessionId: string;
  bot: { id: string; aliasId: string; aliasName?: string; localeId: string };
  sessionState: {
    sessionAttributes?: Record<string, string>;
    intent: { name: string; state?: string };
  };
  inputTranscript?: string;
};

export type LexVoiceResponse = {
  sessionState: {
    sessionAttributes: Record<string, string>;
    dialogAction: { type: "ElicitIntent" | "Close" };
    intent?: { name: string; state: "Fulfilled" | "Failed" };
  };
  messages: Array<{ contentType: "PlainText"; content: string }>;
};

export type LexVoiceGuard = {
  enabled: boolean;
  allowedBotIds: string[];
  allowedAliasNames: string[];
  allowedLocales: string[];
};

/** Session attributes are the only state carried between Lex turns. */
const PROCUREMENT_SESSION = "stockguardSessionId";
const MISSION = "stockguardMissionId";
const EVALUATION = "stockguardEvaluationId";
const CONFIRMATION = "stockguardConfirmationToken";

function reply(
  event: LexVoiceEvent,
  attributes: Record<string, string>,
  content: string,
  close: boolean,
  state: "Fulfilled" | "Failed" = "Fulfilled",
): LexVoiceResponse {
  return {
    sessionState: {
      sessionAttributes: attributes,
      dialogAction: { type: close ? "Close" : "ElicitIntent" },
      ...(close ? { intent: { name: event.sessionState.intent.name, state } } : {}),
    },
    messages: [{ contentType: "PlainText", content }],
  };
}

function failClosed(event: LexVoiceEvent, code: string): LexVoiceResponse {
  return reply(
    event,
    { ...(event.sessionState.sessionAttributes ?? {}), stockguardError: code },
    "StockGuard cannot handle this request right now.",
    true,
    "Failed",
  );
}

/**
 * Trims a message down to something worth hearing.
 *
 * A spoken reply is not a written one: the full policy explanation lists every
 * failing check and takes far too long to listen to. This keeps the leading
 * sentences, which carry the decision and the figures, and drops the rest.
 * Nothing is rephrased, so no figure can change on the way out.
 */
export function toSpokenSummary(message: string, maxSentences = 3): string {
  const sentences = message
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.slice(0, maxSentences).join(" ");
}

export type LexVoiceDependencies = {
  orchestrator: ProcurementOrchestrator;
  sessions: ProcurementSessionStore;
};

export function createLexVoiceHandler(
  dependencies: LexVoiceDependencies,
  guard: LexVoiceGuard,
): (event: LexVoiceEvent) => Promise<LexVoiceResponse> {
  const { orchestrator } = dependencies;

  return async (event) => {
    if (!guard.enabled) return failClosed(event, "VOICE_DISABLED");
    if (!guard.allowedBotIds.includes(event.bot.id)) {
      return failClosed(event, "BOT_NOT_ALLOWED");
    }
    if (
      guard.allowedAliasNames.length === 0 ||
      typeof event.bot.aliasName !== "string" ||
      !guard.allowedAliasNames.includes(event.bot.aliasName)
    ) {
      return failClosed(event, "ALIAS_NOT_ALLOWED");
    }
    if (!guard.allowedLocales.includes(event.bot.localeId)) {
      return failClosed(event, "LOCALE_NOT_ALLOWED");
    }

    const attributes = { ...(event.sessionState.sessionAttributes ?? {}) };
    const intent = event.sessionState.intent.name;

    /*
     * The contact flow sets stockguardMissionId as a contact attribute. A
     * missing or unknown mission falls back to the single Friday mission rather
     * than failing the call: the judge is already on the phone.
     */
    const mission = findMission(attributes[MISSION] ?? "") ?? defaultMission;

    try {
      if (intent === "ConfirmPurchase" || intent === "DeclinePurchase") {
        const sessionId = attributes[PROCUREMENT_SESSION];
        const evaluationId = attributes[EVALUATION];
        const token = attributes[CONFIRMATION];
        if (!sessionId || !evaluationId) {
          return reply(
            event,
            attributes,
            "There is nothing to confirm yet. Tell me what you need first.",
            false,
          );
        }

        if (intent === "DeclinePurchase" || !token) {
          const declined = await orchestrator.confirm(sessionId, evaluationId, token ?? "", false);
          return reply(event, attributes, toSpokenSummary(declined.message), true);
        }

        const confirmed = await orchestrator.confirm(sessionId, evaluationId, token, true);
        // The token is spent; never leave it where a later turn could reuse it.
        delete attributes[CONFIRMATION];
        delete attributes[EVALUATION];
        return reply(event, attributes, toSpokenSummary(confirmed.message), true);
      }

      const transcript = event.inputTranscript?.trim() ?? "";
      if (transcript.length === 0) {
        return reply(
          event,
          attributes,
          `Tell me what you need. For example: ${mission.exampleUtterance}`,
          false,
        );
      }

      /*
       * One procurement session per Lex conversation. Reusing it across turns
       * is what lets a judge correct themselves without starting over, and what
       * makes the audit trail one run rather than several.
       */
      let sessionId = attributes[PROCUREMENT_SESSION];
      if (!sessionId) {
        const started = await orchestrator.startSession(mission.missionId);
        sessionId = started.sessionId;
        attributes[PROCUREMENT_SESSION] = sessionId;
        attributes[MISSION] = mission.missionId;
      }

      const turn = await orchestrator.handleUtterance(sessionId, transcript);

      if (turn.evaluation?.outcome === "HUMAN_REVIEW_REQUIRED") {
        const escalated = await orchestrator.escalate(sessionId, turn.evaluation.evaluationId);
        return reply(
          event,
          attributes,
          toSpokenSummary(`${turn.message} ${escalated.message}`, 3),
          true,
        );
      }

      if (turn.evaluation?.outcome === "ACCEPTED" && turn.confirmationToken) {
        attributes[EVALUATION] = turn.evaluation.evaluationId;
        attributes[CONFIRMATION] = turn.confirmationToken;
        return reply(event, attributes, toSpokenSummary(turn.message), false);
      }

      // Rejected, out of domain, ambiguous or a tool failure: say why, keep
      // listening so the judge can try again within the same run.
      return reply(event, attributes, toSpokenSummary(turn.message), false);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "LEX_VOICE_ERROR",
          intent,
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return failClosed(event, "ORCHESTRATOR_ERROR");
    }
  };
}
