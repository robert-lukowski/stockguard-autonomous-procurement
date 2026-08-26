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
  it("passes the caller utterance and all supplier facts to Bedrock", async () => {
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
      conversation: [
        { role: "caller", text: "Can you confirm the quote?" },
      ],
    }));
    expect(JSON.parse(response.sessionState.sessionAttributes.conversationHistory)).toEqual([
      { role: "caller", text: "Can you confirm the quote?" },
      {
        role: "supplier",
        text: "Sure. We have all eight CF-220 units available at 41 EUR each.",
      },
    ]);
  });

  it("keeps the complete conversation across multiple turns", async () => {
    const realize = vi.fn()
      .mockResolvedValueOnce("Yes, all eight are available at 41 EUR each.")
      .mockResolvedValueOnce("Delivery is September 29, the quote is valid until September 24, and payment is now in advance.");
    const supplier = handler({ realize });

    const first = await supplier(event("GetSupplierQuote", {
      inputTranscript: "Do you have eight CF 220 units and what is the price?",
    }));
    const second = await supplier(event("ConfirmCommercialTerms", {
      inputTranscript: "What about delivery, validity and payment terms?",
      sessionState: {
        sessionAttributes: first.sessionState.sessionAttributes,
        intent: { name: "ConfirmCommercialTerms" },
      },
    }));

    expect(realize).toHaveBeenCalledTimes(2);
    expect(realize.mock.calls[1][0].conversation).toEqual([
      { role: "caller", text: "Do you have eight CF 220 units and what is the price?" },
      { role: "supplier", text: "Yes, all eight are available at 41 EUR each." },
      { role: "caller", text: "What about delivery, validity and payment terms?" },
    ]);
    expect(JSON.parse(second.sessionState.sessionAttributes.conversationHistory)).toEqual([
      { role: "caller", text: "Do you have eight CF 220 units and what is the price?" },
      { role: "supplier", text: "Yes, all eight are available at 41 EUR each." },
      { role: "caller", text: "What about delivery, validity and payment terms?" },
      {
        role: "supplier",
        text: "Delivery is September 29, the quote is valid until September 24, and payment is now in advance.",
      },
    ]);
  });

  it("keeps EndConversation fulfilled and closed while preserving context", async () => {
    const response = await handler({
      realize: vi.fn().mockResolvedValue("Thank you for calling. Goodbye."),
    })(event("EndConversation", {
      inputTranscript: "Thanks, that is all I needed.",
      sessionState: {
        sessionAttributes: {
          conversationHistory: JSON.stringify([
            { role: "caller", text: "Do you have the item?" },
            { role: "supplier", text: "Yes, we do." },
          ]),
        },
        intent: { name: "EndConversation" },
      },
    }));

    expect(response.sessionState.dialogAction.type).toBe("Close");
    expect(response.sessionState.intent).toEqual({
      name: "EndConversation",
      state: "Fulfilled",
    });
    expect(JSON.parse(response.sessionState.sessionAttributes.conversationHistory)).toHaveLength(4);
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
