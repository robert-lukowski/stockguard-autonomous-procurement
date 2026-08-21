import { SupplierSimulatorService } from "./SupplierSimulatorService";
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
  allowedLocales: LexSimulatorLocale[];
};

const intents = new Set<SupplierSimulatorIntent>([
  "GetSupplierQuote",
  "CheckRemainingQuantity",
  "ConfirmOfferValidity",
  "ConfirmCommercialTerms",
  "EndConversation",
]);

const profileIds = new Set<SupplierProfileId>([
  "DE_SUPPLIER",
  "FR_SUPPLIER",
  "PL_SUPPLIER",
]);

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

export function createSupplierSimulatorLexHandler(
  service: SupplierSimulatorService,
  guard: SupplierSimulatorLambdaGuard,
): (event: LexV2Event) => Promise<LexV2Response> {
  return async (event) => {
    if (!guard.enabled) return failed(event, "SIMULATOR_DISABLED");
    if (
      !guard.allowedBotIds.includes(event.bot.id) ||
      !guard.allowedAliasIds.includes(event.bot.aliasId)
    ) {
      return failed(event, "BOT_NOT_ALLOWED");
    }
    if (!guard.allowedLocales.includes(event.bot.localeId as LexSimulatorLocale)) {
      return failed(event, "LOCALE_NOT_ALLOWED");
    }
    const attributes = event.sessionState.sessionAttributes ?? {};
    const rfqId = attributes.rfqId ?? slot(event, "RfqId");
    const rawProfileId = attributes.supplierProfileId ?? slot(event, "SupplierProfile");
    const profileId = rawProfileId && profileIds.has(rawProfileId as SupplierProfileId)
      ? rawProfileId as SupplierProfileId
      : undefined;
    if (!rfqId || (rawProfileId && !profileId)) {
      return failed(event, "RFQ_CONTEXT_INVALID");
    }

    if (event.sessionState.intent.name === "IdentifySyntheticRfq") {
      if (event.bot.localeId !== "en_GB") {
        return failed(event, "ROUTER_LOCALE_MISMATCH");
      }
      try {
        const context = await service.resolveContext(rfqId, profileId);
        return {
          sessionState: {
            sessionAttributes: {
              ...attributes,
              runId: context.rfq.runId,
              rfqId: context.rfq.rfqId,
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
    const intent = event.sessionState.intent.name as SupplierSimulatorIntent;
    if (!intents.has(intent)) return failed(event, "INTENT_NOT_ALLOWED");

    try {
      const result = await service.respond({ intent, rfqId, profileId });
      if (result.quote.locale !== event.bot.localeId) {
        return failed(event, "PROFILE_LOCALE_MISMATCH");
      }
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
          },
          dialogAction: {
            type: result.continueConversation ? "ElicitIntent" : "Close",
          },
          ...(result.continueConversation
            ? {}
            : { intent: { name: intent, state: "Fulfilled" as const } }),
        },
        messages: [{ contentType: "PlainText", content: result.message }],
      };
    } catch {
      return failed(event, "SYNTHETIC_DATA_UNAVAILABLE");
    }
  };
}
