import { syntheticSupplierProfiles } from "./profiles";
import { SupplierSimulatorService } from "./SupplierSimulatorService";
import {
  realizeSupplierResponse,
  type SupplierConversationTurn,
  type SupplierResponseRealizer,
} from "./SupplierResponseRealizer";
import type {
  LexSimulatorLocale,
  SupplierProfileId,
  SupplierSimulatorIntent,
} from "./types";

type LexSlot = {
  value?: { interpretedValue?: string };
} | null;

export type LexV2Event = {
  sessionId: string;
  bot: {
    id: string;
    aliasId: string;
    aliasName?: string;
    localeId: string;
  };
  sessionState: {
    sessionAttributes?: Record<string, string>;
    intent: {
      name: string;
      slots?: Record<string, LexSlot>;
      state?: string;
    };
  };
  inputTranscript?: string;
};

export type LexV2Response = {
  sessionState: {
    sessionAttributes: Record<string, string>;
    dialogAction: { type: "ElicitIntent" | "Close" };
    intent?: {
      name: string;
      state: "Fulfilled" | "Failed";
    };
  };
  messages: Array<{
    contentType: "PlainText";
    content: string;
  }>;
};

export type SupplierSimulatorLambdaGuard = {
  enabled: boolean;
  allowedBotIds: string[];
  allowedAliasIds: string[];
  allowedAliasNames?: string[];
  allowedLocales: LexSimulatorLocale[];
  qualificationRfqId?: string;
};

const intents = new Set<SupplierSimulatorIntent>([
  "GetSupplierQuote",
  "CheckRemainingQuantity",
  "ConfirmOfferValidity",
  "ConfirmCommercialTerms",
  "EndConversation",
]);

const profileIds = new Set<SupplierProfileId>(
  Object.keys(syntheticSupplierProfiles) as SupplierProfileId[],
);

const CONVERSATION_HISTORY_ATTRIBUTE = "conversationHistory";
// Lex session attributes are bounded. A one-to-two-minute qualification is
// comfortably below this guard; if that assumption is ever violated we fail
// closed rather than silently dropping the beginning of the conversation.
const MAX_CONVERSATION_HISTORY_CHARS = 9_000;

function aliasAllowed(
  event: LexV2Event,
  guard: SupplierSimulatorLambdaGuard,
): boolean {
  const names = guard.allowedAliasNames ?? [];
  if (guard.allowedAliasIds.length === 0 && names.length === 0) return false;

  const idMatches = guard.allowedAliasIds.includes(event.bot.aliasId);
  const nameMatches =
    typeof event.bot.aliasName === "string" &&
    event.bot.aliasName.length > 0 &&
    names.includes(event.bot.aliasName);
  return idMatches || nameMatches;
}

function slot(event: LexV2Event, name: string): string | undefined {
  return event.sessionState.intent.slots?.[name]?.value?.interpretedValue;
}

function failed(event: LexV2Event, code: string): LexV2Response {
  return {
    sessionState: {
      sessionAttributes: {
        ...(event.sessionState.sessionAttributes ?? {}),
        simulatorStatus: "FAILED_CLOSED",
        simulatorError: code,
      },
      dialogAction: { type: "Close" },
      intent: { name: event.sessionState.intent.name, state: "Failed" },
    },
    messages: [{
      contentType: "PlainText",
      content: "The synthetic supplier test harness cannot provide a quote for this request.",
    }],
  };
}

function conversationHistory(
  attributes: Record<string, string>,
): SupplierConversationTurn[] {
  const encoded = attributes[CONVERSATION_HISTORY_ATTRIBUTE];
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((turn): turn is SupplierConversationTurn =>
      typeof turn === "object" &&
      turn !== null &&
      "role" in turn &&
      (turn.role === "caller" || turn.role === "supplier") &&
      "text" in turn &&
      typeof turn.text === "string" &&
      turn.text.trim().length > 0
    ).map((turn) => ({ role: turn.role, text: turn.text.trim() }));
  } catch {
    return [];
  }
}

function serializeConversation(history: SupplierConversationTurn[]): string {
  const encoded = JSON.stringify(history);
  if (encoded.length > MAX_CONVERSATION_HISTORY_CHARS) {
    throw new Error("CONVERSATION_CONTEXT_TOO_LARGE");
  }
  return encoded;
}

export function createSupplierSimulatorLexHandler(
  service: SupplierSimulatorService,
  guard: SupplierSimulatorLambdaGuard,
  responseRealizer?: SupplierResponseRealizer,
): (event: LexV2Event) => Promise<LexV2Response> {
  return async (event) => {
    if (!guard.enabled) return failed(event, "SIMULATOR_DISABLED");
    if (!guard.allowedBotIds.includes(event.bot.id)) {
      return failed(event, "BOT_NOT_ALLOWED");
    }
    if (!aliasAllowed(event, guard)) {
      return failed(event, "ALIAS_NOT_ALLOWED");
    }
    if (!guard.allowedLocales.includes(event.bot.localeId as LexSimulatorLocale)) {
      return failed(event, "LOCALE_NOT_ALLOWED");
    }
    const attributes = event.sessionState.sessionAttributes ?? {};
    const rfqId = attributes.rfqId ?? slot(event, "RfqId");
    const routingCode = attributes.routingCode ?? slot(event, "RoutingCode");
    const rawProfileId = attributes.supplierProfileId ?? slot(event, "SupplierProfile");
    const profileId = rawProfileId && profileIds.has(rawProfileId as SupplierProfileId)
      ? rawProfileId as SupplierProfileId
      : undefined;
    if (rawProfileId && !profileId) {
      return failed(event, "RFQ_CONTEXT_INVALID");
    }

    if (event.sessionState.intent.name === "IdentifySyntheticRfq") {
      if (event.bot.localeId !== "en_GB") {
        return failed(event, "ROUTER_LOCALE_MISMATCH");
      }
      if (!routingCode) return failed(event, "ROUTING_CODE_MISSING");
      try {
        const context = await service.resolveRoutingContext(routingCode, profileId);
        return {
          sessionState: {
            sessionAttributes: {
              ...attributes,
              runId: context.rfq.runId,
              rfqId: context.rfq.rfqId,
              routingCode: context.rfq.routingCode,
              supplierProfileId: context.profile.profileId,
              supplierId: context.profile.supplierId,
              targetLocale: context.profile.locale,
              simulatorStatus: "ROUTED_SYNTHETIC",
              datasetVersion: context.profile.datasetVersion,
            },
            dialogAction: { type: "Close" },
            intent: { name: "IdentifySyntheticRfq", state: "Fulfilled" },
          },
          messages: [{
            contentType: "PlainText",
            content: `Synthetic RFQ recognized. Switching to ${context.profile.locale}.`,
          }],
        };
      } catch {
        return failed(event, "SYNTHETIC_DATA_UNAVAILABLE");
      }
    }

    const effectiveRfqId = rfqId ?? guard.qualificationRfqId;
    if (!effectiveRfqId) return failed(event, "RFQ_CONTEXT_INVALID");
    const intent = event.sessionState.intent.name as SupplierSimulatorIntent;
    if (!intents.has(intent)) return failed(event, "INTENT_NOT_ALLOWED");

    try {
      const result = await service.respond({
        intent,
        rfqId: effectiveRfqId,
        profileId,
      });
      if (result.quote.locale !== event.bot.localeId) {
        return failed(event, "PROFILE_LOCALE_MISMATCH");
      }

      const priorConversation = conversationHistory(attributes);
      const callerText = event.inputTranscript?.trim() ?? "";
      const conversationForModel: SupplierConversationTurn[] = callerText.length > 0
        ? [...priorConversation, { role: "caller", text: callerText }]
        : priorConversation;
      const naturalMessage = responseRealizer
        ? await realizeSupplierResponse(responseRealizer, result, conversationForModel)
        : result.message;
      const conversationAfterTurn: SupplierConversationTurn[] = [
        ...conversationForModel,
        { role: "supplier", text: naturalMessage },
      ];
      const encodedConversation = serializeConversation(conversationAfterTurn);

      return {
        sessionState: {
          sessionAttributes: {
            ...attributes,
            runId: result.quote.runId,
            rfqId: result.quote.rfqId,
            supplierProfileId: result.quote.profileId,
            supplierId: result.quote.supplierId,
            simulatorStatus: "SYNTHETIC",
            datasetVersion: result.quote.datasetVersion,
            [CONVERSATION_HISTORY_ATTRIBUTE]: encodedConversation,
          },
          dialogAction: {
            type: result.continueConversation ? "ElicitIntent" : "Close",
          },
          ...(result.continueConversation
            ? {}
            : { intent: { name: intent, state: "Fulfilled" as const } }),
        },
        messages: [{ contentType: "PlainText", content: naturalMessage }],
      };
    } catch (error) {
      if (error instanceof Error && error.message === "CONVERSATION_CONTEXT_TOO_LARGE") {
        return failed(event, "CONVERSATION_CONTEXT_TOO_LARGE");
      }
      return failed(event, "SYNTHETIC_DATA_UNAVAILABLE");
    }
  };
}
