import { describe, expect, it } from "vitest";
import {
  createSupplierSimulatorLexHandler,
  InMemorySyntheticSupplierStore,
  SupplierSimulatorService,
  syntheticSupplierProfiles,
  type LexV2Event,
  type SyntheticRfq,
} from ".";

const rfqs: SyntheticRfq[] = [
  {
    runId: "run-081",
    rfqId: "RFQ-DE-081",
    routingCode: "281001",
    profileId: "DE_SUPPLIER",
    datasetVersion: "synthetic-suppliers-2026-08-v1",
    sku: "CF-220",
    requestedQuantity: 1_000,
    requiredBy: "2026-08-28T12:00:00+02:00",
    expiresAt: "2026-08-21T10:00:00Z",
  },
  {
    runId: "run-081",
    rfqId: "RFQ-FR-081",
    routingCode: "281002",
    profileId: "FR_SUPPLIER",
    datasetVersion: "synthetic-suppliers-2026-08-v1",
    sku: "CF-220",
    requestedQuantity: 1_000,
    requiredBy: "2026-08-28T12:00:00+02:00",
    expiresAt: "2026-08-21T10:00:00Z",
  },
  {
    runId: "run-081",
    rfqId: "RFQ-PL-081",
    routingCode: "281003",
    profileId: "PL_SUPPLIER",
    datasetVersion: "synthetic-suppliers-2026-08-v1",
    sku: "CF-220",
    requestedQuantity: 1_000,
    requiredBy: "2026-08-28T12:00:00+02:00",
    expiresAt: "2026-08-21T10:00:00Z",
  },
];

function serviceFixture() {
  const store = new InMemorySyntheticSupplierStore(undefined, rfqs);
  return {
    store,
    service: new SupplierSimulatorService(
      store,
      () => new Date("2026-08-21T09:00:00Z"),
    ),
  };
}

function event(overrides: Partial<LexV2Event> = {}): LexV2Event {
  return {
    sessionId: "lex-session-1",
    bot: { id: "bot-1", aliasId: "alias-1", localeId: "de_DE" },
    sessionState: {
      sessionAttributes: {
        rfqId: "RFQ-DE-081",
        supplierProfileId: "DE_SUPPLIER",
      },
      intent: { name: "GetSupplierQuote", slots: {} },
    },
    ...overrides,
  };
}

describe("SupplierSimulatorService", () => {
  it("generates the deterministic partial-stock profile and a follow-up answer", async () => {
    const { service } = serviceFixture();

    const quote = await service.respond({
      intent: "GetSupplierQuote",
      rfqId: "RFQ-DE-081",
    });
    const followUp = await service.respond({
      intent: "CheckRemainingQuantity",
      rfqId: "RFQ-DE-081",
    });

    expect(quote.quote).toMatchObject({
      runId: "run-081",
      availableQuantity: 700,
      remainingQuantity: 300,
      currency: "EUR",
      state: "PARTIAL_STOCK",
      deterministic: true,
    });
    expect(Date.parse(followUp.quote.remainingDeliveryAt ?? "")).toBeGreaterThan(
      Date.parse(rfqs[0].requiredBy),
    );
    expect(followUp.message).toContain("300");
  });

  it("produces one repeatable rejection cause for every default profile", async () => {
    const { service } = serviceFixture();

    const de = (await service.respond({ intent: "GetSupplierQuote", rfqId: "RFQ-DE-081" })).quote;
    const fr = (await service.respond({ intent: "GetSupplierQuote", rfqId: "RFQ-FR-081" })).quote;
    const pl = (await service.respond({ intent: "GetSupplierQuote", rfqId: "RFQ-PL-081" })).quote;

    expect(de.availableQuantity).toBeLessThan(de.requestedQuantity);
    expect(Date.parse(fr.deliveryAt)).toBeGreaterThan(Date.parse(rfqs[1].requiredBy));
    expect(pl.commercialTermsChanged).toBe(true);
  });

  it("allows a profile state to be changed before a controlled test", async () => {
    const { store, service } = serviceFixture();
    store.setProfile({
      ...syntheticSupplierProfiles.DE_SUPPLIER,
      state: "OUT_OF_STOCK",
      datasetVersion: "test-override-v1",
    });
    store.setRfq({ ...rfqs[0], datasetVersion: "test-override-v1" });

    const result = await service.respond({
      intent: "GetSupplierQuote",
      rfqId: "RFQ-DE-081",
    });

    expect(result.quote).toMatchObject({
      availableQuantity: 0,
      state: "OUT_OF_STOCK",
      datasetVersion: "test-override-v1",
    });
  });

  it("rejects an RFQ pinned to a stale supplier dataset", async () => {
    const { store, service } = serviceFixture();
    store.setProfile({
      ...syntheticSupplierProfiles.DE_SUPPLIER,
      datasetVersion: "synthetic-suppliers-2026-08-v2",
    });

    await expect(
      service.resolveContext("RFQ-DE-081"),
    ).rejects.toThrow("dataset version does not match");
  });

  it("fails closed after the short-lived synthetic RFQ expires", async () => {
    const store = new InMemorySyntheticSupplierStore(undefined, rfqs);
    const service = new SupplierSimulatorService(
      store,
      () => new Date("2026-08-21T10:00:00Z"),
    );

    await expect(
      service.resolveRoutingContext("281001"),
    ).rejects.toThrow("Synthetic RFQ has expired");
  });
});

describe("Lex V2 fail-closed handler", () => {
  const guard = {
    enabled: true,
    allowedBotIds: ["bot-1"],
    allowedAliasIds: ["alias-1"],
    allowedLocales: ["en_GB", "de_DE", "fr_FR", "pl_PL"] as const,
  };

  it("resolves an RFQ in the routing locale before the localized conversation", async () => {
    const { service } = serviceFixture();
    const handler = createSupplierSimulatorLexHandler(service, {
      ...guard,
      allowedLocales: [...guard.allowedLocales],
    });

    const response = await handler(event({
      bot: { id: "bot-1", aliasId: "alias-1", localeId: "en_GB" },
      sessionState: {
        sessionAttributes: {},
        intent: {
          name: "IdentifySyntheticRfq",
          slots: {
            RoutingCode: { value: { interpretedValue: "281001" } },
          },
        },
      },
    }));

    expect(response.sessionState).toMatchObject({
      dialogAction: { type: "Close" },
      intent: { state: "Fulfilled" },
      sessionAttributes: {
        runId: "run-081",
        routingCode: "281001",
        supplierProfileId: "DE_SUPPLIER",
        targetLocale: "de_DE",
      },
    });
  });

  it("returns dynamic data and preserves the StockGuard runId", async () => {
    const { service } = serviceFixture();
    const handler = createSupplierSimulatorLexHandler(service, {
      ...guard,
      allowedLocales: [...guard.allowedLocales],
    });

    const response = await handler(event());

    expect(response.sessionState.dialogAction.type).toBe("ElicitIntent");
    expect(response.sessionState.sessionAttributes).toMatchObject({
      runId: "run-081",
      rfqId: "RFQ-DE-081",
      simulatorStatus: "SYNTHETIC",
    });
    expect(response.messages[0].content).toContain("700");
  });

  it("rejects a disabled simulator without reading supplier data", async () => {
    const { service } = serviceFixture();
    const handler = createSupplierSimulatorLexHandler(service, {
      ...guard,
      enabled: false,
      allowedLocales: [...guard.allowedLocales],
    });

    const response = await handler(event());

    expect(response.sessionState.intent?.state).toBe("Failed");
    expect(response.sessionState.sessionAttributes.simulatorError).toBe(
      "SIMULATOR_DISABLED",
    );
  });

  it("rejects a bot, locale or profile mismatch", async () => {
    const { service } = serviceFixture();
    const handler = createSupplierSimulatorLexHandler(service, {
      ...guard,
      allowedLocales: [...guard.allowedLocales],
    });

    const wrongBot = await handler(event({
      bot: { id: "unknown", aliasId: "alias-1", localeId: "de_DE" },
    }));
    const wrongLocale = await handler(event({
      bot: { id: "bot-1", aliasId: "alias-1", localeId: "fr_FR" },
    }));

    expect(wrongBot.sessionState.sessionAttributes.simulatorError).toBe(
      "BOT_NOT_ALLOWED",
    );
    expect(wrongLocale.sessionState.sessionAttributes.simulatorError).toBe(
      "PROFILE_LOCALE_MISMATCH",
    );
  });
});
