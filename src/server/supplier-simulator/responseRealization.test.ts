import { describe, expect, it, vi } from "vitest";
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  createSupplierSimulatorLexHandler,
  type LexV2Event,
  type SupplierResponseRealizer,
  type SyntheticRfq,
} from ".";

const rfq: SyntheticRfq = {
  runId: "qualification-run",
  rfqId: "RFQ-EN-QUALIFICATION",
  routingCode: "000001",
  profileId: "EN_SUPPLIER",
  datasetVersion: "synthetic-suppliers-2026-08-v1",
  sku: "CF-220",
  requestedQuantity: 8,
  requiredBy: "2026-09-30T12:00:00+02:00",
  expiresAt: "2099-01-01T00:00:00Z",
};

function service(): SupplierSimulatorService {
  return new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(undefined, [rfq]),
    () => new Date("2026-08-25T08:00:00Z"),
  );
}

const guard = {
  enabled: true,
  allowedBotIds: ["BOTID123"],
  allowedAliasIds: ["ALIASID123"],
  allowedAliasNames: ["qualification"],
  allowedLocales: ["en_US", "en_GB"] as const,
  qualificationRfqId: rfq.rfqId,
};

function event(
  intent = "GetSupplierQuote",
  overrides: Partial<LexV2Event> = {},
): LexV2Event {
  return {
    sessionId: "session-1",
    bot: {
      id: "BOTID123",
      aliasId: "ALIASID123",
      aliasName: "qualification",
      localeId: "en_US",
    },
    sessionState: { intent: { name: intent } },
    inputTranscript: "Can you confirm the quote?",
    ...overrides,
  };
}

function handler(
  responseRealizer: SupplierResponseRealizer,
  guardOverrides = {},
) {
  return createSupplierSimulatorLexHandler(
    service(),
    {
      ...guard,
      ...guardOverrides,
      allowedLocales: [...guard.allowedLocales],
    },
    responseRealizer,
  );
}

describe("Lex supplier response realization", () => {
  it("places natural Bedrock text in PlainText while preserving deterministic quote facts", async () => {
    const realize = vi.fn().mockResolvedValue(
      "Sure. We have all eight CF-220 units available at 41 EUR each.",
    );
    const simulator = service();
    const quoteBefore = (await simulator.respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    })).quote;

    const response = await handler({ realize })(event());
    const quoteAfter = (await simulator.respond({
      intent: "GetSupplierQuote",
      rfqId: rfq.rfqId,
      profileId: "EN_SUPPLIER",
    })).quote;

    expect(response.messages).toEqual([{
      contentType: "PlainText",
      content: "Sure. We have all eight CF-220 units available at 41 EUR each.",
    }]);
    expect(response.sessionState.dialogAction.type).toBe("ElicitIntent");
    expect(quoteAfter).toEqual(quoteBefore);
    expect(realize).toHaveBeenCalledWith(expect.objectContaining({
      intent: "GetSupplierQuote",
      supplierName: "Ridgeline Industrial Supply",
      sku: "CF-220",
      requestedQuantity: 8,
      availableQuantity: 8,
      unitPrice: 41,
      currency: "EUR",
      deliveryAt: expect.stringContaining("2026-09-29"),
      offerValidUntil: expect.stringContaining("2026-09-24"),
      commercialTermsChanged: true,
      commercialTermsSummary: "Payment terms changed from net 30 to advance payment.",
    }));
    // The caller's raw utterance is deliberately not forwarded to the
    // realizer: the intent is enough to decide what to answer, and
    // avoiding it removes a prompt-injection surface.
    expect(realize.mock.calls[0][0]).not.toHaveProperty("latestCallerQuestion");
  });

  it("keeps EndConversation fulfilled and closed", async () => {
    const response = await handler({
      realize: vi.fn().mockResolvedValue("Thank you for calling. Goodbye."),
    })(event("EndConversation"));

    expect(response.sessionState.dialogAction.type).toBe("Close");
    expect(response.sessionState.intent).toEqual({
      name: "EndConversation",
      state: "Fulfilled",
    });
  });

  it("does not call Bedrock on guard failures", async () => {
    const realize = vi.fn();

    const disabled = await handler({ realize }, { enabled: false })(event());
    const wrongBot = await handler({ realize })(event("GetSupplierQuote", {
      bot: {
        id: "OTHER",
        aliasId: "ALIASID123",
        aliasName: "qualification",
        localeId: "en_US",
      },
    }));
    const invalidProfile = await handler({ realize })(event("GetSupplierQuote", {
      sessionState: {
        sessionAttributes: { supplierProfileId: "NOT_A_PROFILE" },
        intent: { name: "GetSupplierQuote" },
      },
    }));
    const wrongLocale = await handler({ realize })(event("GetSupplierQuote", {
      bot: {
        id: "BOTID123",
        aliasId: "ALIASID123",
        aliasName: "qualification",
        localeId: "en_GB",
      },
    }));

    expect(disabled.sessionState.sessionAttributes.simulatorError).toBe("SIMULATOR_DISABLED");
    expect(wrongBot.sessionState.sessionAttributes.simulatorError).toBe("BOT_NOT_ALLOWED");
    expect(invalidProfile.sessionState.sessionAttributes.simulatorError).toBe("RFQ_CONTEXT_INVALID");
    expect(wrongLocale.sessionState.sessionAttributes.simulatorError).toBe("PROFILE_LOCALE_MISMATCH");
    expect(realize).not.toHaveBeenCalled();
  });

  it("does not call Bedrock for IdentifySyntheticRfq", async () => {
    const realize = vi.fn();
    const response = await handler({ realize })(event("IdentifySyntheticRfq", {
      bot: {
        id: "BOTID123",
        aliasId: "ALIASID123",
        aliasName: "qualification",
        localeId: "en_GB",
      },
      sessionState: {
        intent: {
          name: "IdentifySyntheticRfq",
          slots: {
            RoutingCode: { value: { interpretedValue: "000001" } },
          },
        },
      },
    }));

    expect(response.sessionState.intent?.state).toBe("Fulfilled");
    expect(realize).not.toHaveBeenCalled();
  });
});
