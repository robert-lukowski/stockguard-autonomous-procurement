import { describe, expect, it } from "vitest";
import {
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  createSupplierSimulatorLexHandler,
  syntheticSupplierProfiles,
  type LexV2Event,
  type SupplierProfileId,
  type SupplierSimulatorLambdaGuard,
  type SyntheticRfq,
} from ".";

const rfq: SyntheticRfq = {
  runId: "qual-run-1",
  rfqId: "RFQ-EN-QUAL-1",
  routingCode: "100001",
  profileId: "EN_SUPPLIER",
  datasetVersion: "synthetic-suppliers-2026-08-v1",
  sku: "CF-220",
  requestedQuantity: 8,
  requiredBy: "2026-08-28T12:00:00+02:00",
  expiresAt: "2099-01-01T00:00:00Z",
};

const guard: SupplierSimulatorLambdaGuard = {
  enabled: true,
  allowedBotIds: ["BOTID123"],
  allowedAliasIds: [],
  allowedAliasNames: ["qualification"],
  allowedLocales: ["en_US"],
  qualificationRfqId: rfq.rfqId,
};

function handler(overrides: Partial<SupplierSimulatorLambdaGuard> = {}) {
  const service = new SupplierSimulatorService(
    new InMemorySyntheticSupplierStore(undefined, [rfq]),
    () => new Date("2026-08-21T10:30:00Z"),
  );
  return createSupplierSimulatorLexHandler(service, { ...guard, ...overrides });
}

function event(
  intent: string,
  sessionAttributes: Record<string, string> = {},
  bot: Partial<LexV2Event["bot"]> = {},
): LexV2Event {
  return {
    sessionId: "session-1",
    bot: {
      id: "BOTID123",
      aliasId: "GENERATEDALIASID",
      aliasName: "qualification",
      localeId: "en_US",
      ...bot,
    },
    sessionState: { sessionAttributes, intent: { name: intent } },
  };
}

describe("English multi-turn conversation", () => {
  it("survives the follow-up turn that reads its own session attributes back", async () => {
    const lex = handler();

    // TURN 1 - CALL-E asks for the quote.
    const turn1 = await lex(event("GetSupplierQuote"));

    expect(turn1.sessionState.sessionAttributes.simulatorStatus).toBe("SYNTHETIC");
    expect(turn1.sessionState.sessionAttributes.supplierProfileId).toBe("EN_SUPPLIER");
    // Terse English fallback wording (see enSupplier.test).
    expect(turn1.messages[0].content).toContain("8 units of CF-220 available");

    // TURN 2 - the attributes turn 1 emitted are fed straight back, exactly as
    // Lex does on a real call. This is the turn that used to fail closed.
    const turn2 = await lex(
      event("ConfirmCommercialTerms", turn1.sessionState.sessionAttributes),
    );

    expect(turn2.sessionState.sessionAttributes.simulatorStatus).not.toBe(
      "FAILED_CLOSED",
    );
    expect(turn2.sessionState.sessionAttributes.simulatorError).toBeUndefined();
    expect(turn2.messages[0].content).toContain("advance payment");
  });

  it("regression: EN_SUPPLIER read back from attributes is a known profile", async () => {
    const lex = handler();

    const turn = await lex(
      event("GetSupplierQuote", { supplierProfileId: "EN_SUPPLIER" }),
    );

    // The exact failure that shipped: a known profile rejected as invalid.
    expect(turn.sessionState.sessionAttributes.simulatorError).not.toBe(
      "RFQ_CONTEXT_INVALID",
    );
    expect(turn.sessionState.sessionAttributes.supplierProfileId).toBe("EN_SUPPLIER");
  });

  it("allowlists every profile in the registry, so it cannot drift again", async () => {
    const lex = handler();

    for (const profileId of Object.keys(
      syntheticSupplierProfiles,
    ) as SupplierProfileId[]) {
      const turn = await lex(event("GetSupplierQuote", { supplierProfileId: profileId }));
      // EN matches this RFQ; the others mismatch it, which is a different and
      // correct refusal. What must never happen is "unknown profile".
      expect(turn.sessionState.sessionAttributes.simulatorError).not.toBe(
        "RFQ_CONTEXT_INVALID",
      );
    }
  });

  it("still rejects a profile that is not in the registry at all", async () => {
    const lex = handler();

    const turn = await lex(
      event("GetSupplierQuote", { supplierProfileId: "MADE_UP_SUPPLIER" }),
    );

    expect(turn.sessionState.sessionAttributes.simulatorError).toBe(
      "RFQ_CONTEXT_INVALID",
    );
  });
});

describe("alias guard", () => {
  it("accepts the allowlisted alias name when no id is known", async () => {
    const turn = await handler()(event("GetSupplierQuote"));
    expect(turn.sessionState.sessionAttributes.simulatorStatus).toBe("SYNTHETIC");
  });

  it("rejects an alias whose name is not allowlisted", async () => {
    const turn = await handler()(
      event("GetSupplierQuote", {}, { aliasName: "TestBotAlias" }),
    );
    expect(turn.sessionState.sessionAttributes.simulatorError).toBe(
      "ALIAS_NOT_ALLOWED",
    );
  });

  it("rejects an event carrying no alias name when only names are allowlisted", async () => {
    const turn = await handler()(
      event("GetSupplierQuote", {}, { aliasName: undefined }),
    );
    expect(turn.sessionState.sessionAttributes.simulatorError).toBe(
      "ALIAS_NOT_ALLOWED",
    );
  });

  it("still supports id allowlisting for Architecture B", async () => {
    const lex = handler({
      allowedAliasIds: ["GENERATEDALIASID"],
      allowedAliasNames: [],
    });
    const turn = await lex(event("GetSupplierQuote", {}, { aliasName: undefined }));
    expect(turn.sessionState.sessionAttributes.simulatorStatus).toBe("SYNTHETIC");
  });

  it("fails closed when neither allowlist is configured", async () => {
    const lex = handler({ allowedAliasIds: [], allowedAliasNames: [] });
    const turn = await lex(event("GetSupplierQuote"));
    expect(turn.sessionState.sessionAttributes.simulatorError).toBe(
      "ALIAS_NOT_ALLOWED",
    );
  });

  it("fails closed when allowedAliasNames is absent entirely", async () => {
    const lex = handler({ allowedAliasIds: [], allowedAliasNames: undefined });
    const turn = await lex(event("GetSupplierQuote"));
    expect(turn.sessionState.sessionAttributes.simulatorError).toBe(
      "ALIAS_NOT_ALLOWED",
    );
  });
});
