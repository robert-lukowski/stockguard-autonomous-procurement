import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LexV2Event } from "../../../src/server/supplier-simulator";
import { lexFulfillment } from "./supplierSimulatorHandler";

const env = {
  SIMULATOR_ENABLED: "true",
  ALLOWED_LEX_BOT_IDS: "BOTID123",
  ALLOWED_LEX_ALIAS_NAMES: "qualification",
  ALLOWED_LEX_LOCALES: "en_US",
  QUALIFICATION_SKU: "CF-220",
  QUALIFICATION_QUANTITY: "8",
  QUALIFICATION_REQUIRED_BY: "2026-08-28T12:00:00+02:00",
};

function event(overrides: Partial<LexV2Event> = {}): LexV2Event {
  return {
    sessionId: "session-1",
    bot: { id: "BOTID123", aliasId: "GENERATED", aliasName: "qualification", localeId: "en_US" },
    sessionState: { intent: { name: "GetSupplierQuote" } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("supplier simulator Lambda composition root", () => {
  it("answers a quote in English without any RFQ in the session", async () => {
    const response = await lexFulfillment(event());

    expect(response.messages[0].content).toContain("units are available");
    expect(response.sessionState.sessionAttributes.simulatorStatus).toBe("SYNTHETIC");
    expect(response.sessionState.sessionAttributes.supplierProfileId).toBe(
      "EN_SUPPLIER",
    );
  });

  it("is deterministic across invocations", async () => {
    const first = await lexFulfillment(event());
    const second = await lexFulfillment(event());
    expect(first.messages[0].content).toBe(second.messages[0].content);
  });

  it("reports the changed commercial terms that force human review", async () => {
    const response = await lexFulfillment(
      event({
        sessionState: { intent: { name: "ConfirmCommercialTerms" } },
      }),
    );
    expect(response.messages[0].content).toContain("advance payment");
  });

  it("fails closed for a bot, alias or locale outside the guard", async () => {
    const wrongBot = await lexFulfillment(
      event({ bot: { id: "OTHER", aliasId: "GENERATED", aliasName: "qualification", localeId: "en_US" } }),
    );
    const wrongLocale = await lexFulfillment(
      event({ bot: { id: "BOTID123", aliasId: "GENERATED", aliasName: "qualification", localeId: "de_DE" } }),
    );
    const wrongAlias = await lexFulfillment(
      event({ bot: { id: "BOTID123", aliasId: "GENERATED", aliasName: "TestBotAlias", localeId: "en_US" } }),
    );
    expect(wrongAlias.sessionState.sessionAttributes.simulatorStatus).toBe(
      "FAILED_CLOSED",
    );

    expect(wrongBot.sessionState.sessionAttributes.simulatorStatus).toBe(
      "FAILED_CLOSED",
    );
    expect(wrongLocale.sessionState.sessionAttributes.simulatorStatus).toBe(
      "FAILED_CLOSED",
    );
  });

  it("logs operational data only, never conversation content", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await lexFulfillment(event());

    const logged = String(log.mock.calls[0][0]);
    expect(logged).toContain("supplier_simulator_invocation");
    expect(logged).not.toContain("units are available");
    expect(logged).not.toContain("+1");
  });
});
