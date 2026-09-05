import { describe, expect, it } from "vitest";

import {
  InMemoryMetricSink,
  InMemoryProcurementSessionStore,
  ProcurementOrchestrator,
  createLexVoiceHandler,
  toSpokenSummary,
  type LexVoiceEvent,
} from "./index";

/**
 * The vertical voice path, exercised without AWS.
 *
 * Everything from a Lex turn to a spoken reply runs here in process: the same
 * handler the Lambda wires up, the same orchestrator, the same controlled
 * tools. What the tests below assert is not that the wiring compiles, but the
 * two properties that make the path safe to put a microphone in front of.
 */

const guard = {
  enabled: true,
  allowedBotIds: ["bot-1"],
  allowedAliasNames: ["judge"],
  allowedLocales: ["en_US"],
};

function harness() {
  let counter = 0;
  const orchestrator = new ProcurementOrchestrator({
    sessions: new InMemoryProcurementSessionStore(),
    metrics: new InMemoryMetricSink(),
    clock: () => new Date("2026-09-04T09:00:00.000Z"),
    newId: (prefix) => {
      counter += 1;
      return `${prefix}-${String(counter).padStart(4, "0")}`;
    },
    channel: "connect-webrtc",
  });
  const handler = createLexVoiceHandler(
    { orchestrator, sessions: new InMemoryProcurementSessionStore() },
    guard,
  );
  return { orchestrator, handler };
}

function event(
  intent: string,
  transcript: string,
  attributes: Record<string, string> = {},
  overrides: Partial<LexVoiceEvent["bot"]> = {},
): LexVoiceEvent {
  return {
    sessionId: "lex-session-1",
    bot: { id: "bot-1", aliasId: "alias-1", aliasName: "judge", localeId: "en_US", ...overrides },
    sessionState: { sessionAttributes: attributes, intent: { name: intent } },
    inputTranscript: transcript,
  };
}

describe("the spoken vertical path", () => {
  it("takes a spoken request all the way to a confirmation request", async () => {
    const { handler } = harness();

    const spoken = await handler(
      event("RequestProcurement", "I need twenty industrial SSD drives within a week"),
    );

    // Keeps the turn open so the judge can answer.
    expect(spoken.sessionState.dialogAction.type).toBe("ElicitIntent");
    expect(spoken.messages[0].content).toContain("Shall I create the purchase request?");
    // Every figure spoken came from the Supplier Tool and the mission.
    expect(spoken.messages[0].content).toContain("98.00");
    expect(spoken.messages[0].content).toContain("1960.00");
    expect(spoken.sessionState.sessionAttributes.stockguardSessionId).toBeDefined();
  });

  it("creates the purchase request only when the judge says yes", async () => {
    const { handler } = harness();
    const spoken = await handler(
      event("RequestProcurement", "I need twenty industrial SSD drives within a week"),
    );

    const confirmed = await handler(
      event("ConfirmPurchase", "yes", spoken.sessionState.sessionAttributes),
    );

    expect(confirmed.messages[0].content).toContain("Purchase request");
    expect(confirmed.sessionState.dialogAction.type).toBe("Close");
  });

  it("records a spoken refusal as its own outcome", async () => {
    const { handler, orchestrator } = harness();
    const spoken = await handler(
      event("RequestProcurement", "I need twenty industrial SSD drives within a week"),
    );

    const declined = await handler(
      event("DeclinePurchase", "no thanks", spoken.sessionState.sessionAttributes),
    );

    expect(declined.messages[0].content).toContain("not created a purchase request");
    const report = await orchestrator.report(
      spoken.sessionState.sessionAttributes.stockguardSessionId,
    );
    expect(report.outcome).toBe("DECLINED_BY_USER");
  });

  it("says why an over-budget request is refused, and keeps listening", async () => {
    const { handler } = harness();

    const spoken = await handler(
      event("RequestProcurement", "I need forty industrial SSD drives within a week"),
    );

    expect(spoken.messages[0].content).toContain("mission_budget");
    expect(spoken.sessionState.dialogAction.type).toBe("ElicitIntent");
    expect(spoken.sessionState.sessionAttributes.stockguardConfirmationToken).toBeUndefined();
  });

  it("refuses an out-of-domain request out loud", async () => {
    const { handler } = harness();

    const spoken = await handler(event("RequestProcurement", "I would like a pizza"));

    expect(spoken.messages[0].content).toContain("StockGuard industrial IT catalog");
  });
});

describe("the confirmation token never leaves the server", () => {
  it("keeps the token in session attributes, never in the spoken reply", async () => {
    const { handler } = harness();

    const spoken = await handler(
      event("RequestProcurement", "I need twenty industrial SSD drives within a week"),
    );
    const token = spoken.sessionState.sessionAttributes.stockguardConfirmationToken;

    expect(token).toBeDefined();
    // Lex would speak this. A token in it could be replayed by anyone listening.
    expect(spoken.messages[0].content).not.toContain(token);
  });

  it("spends the token, so a second yes cannot buy twice", async () => {
    const { handler } = harness();
    const spoken = await handler(
      event("RequestProcurement", "I need twenty industrial SSD drives within a week"),
    );

    const first = await handler(
      event("ConfirmPurchase", "yes", spoken.sessionState.sessionAttributes),
    );
    const second = await handler(
      event("ConfirmPurchase", "yes", first.sessionState.sessionAttributes),
    );

    expect(first.sessionState.sessionAttributes.stockguardConfirmationToken).toBeUndefined();
    expect(second.messages[0].content).toContain("nothing to confirm yet");
  });

  it("cannot be confirmed before anything was evaluated", async () => {
    const { handler } = harness();

    const spoken = await handler(event("ConfirmPurchase", "yes"));

    expect(spoken.messages[0].content).toContain("nothing to confirm yet");
  });
});

describe("fail-closed guards", () => {
  it("refuses every unexpected bot, alias, locale or a disabled deployment", async () => {
    const { orchestrator } = harness();
    const sessions = new InMemoryProcurementSessionStore();
    const cases: Array<[string, LexVoiceEvent, typeof guard]> = [
      ["disabled", event("RequestProcurement", "hi"), { ...guard, enabled: false }],
      ["bot", event("RequestProcurement", "hi", {}, { id: "other-bot" }), guard],
      ["alias", event("RequestProcurement", "hi", {}, { aliasName: "draft" }), guard],
      ["locale", event("RequestProcurement", "hi", {}, { localeId: "de_DE" }), guard],
      ["no alias allowlist", event("RequestProcurement", "hi"), { ...guard, allowedAliasNames: [] }],
    ];

    for (const [, lexEvent, activeGuard] of cases) {
      const handler = createLexVoiceHandler({ orchestrator, sessions }, activeGuard);
      const response = await handler(lexEvent);

      expect(response.sessionState.intent?.state).toBe("Failed");
      expect(response.messages[0].content).toContain("cannot handle this request");
    }
  });

  it("prompts rather than guessing when the judge said nothing", async () => {
    const { handler } = harness();

    const spoken = await handler(event("RequestProcurement", "   "));

    expect(spoken.messages[0].content).toContain("Tell me what you need");
    expect(spoken.sessionState.dialogAction.type).toBe("ElicitIntent");
  });
});

describe("spoken summary", () => {
  it("keeps the leading sentences and rephrases nothing", () => {
    const message = "One. Two. Three. Four. Five.";

    expect(toSpokenSummary(message)).toBe("One. Two. Three.");
    expect(toSpokenSummary(message, 1)).toBe("One.");
  });

  it("leaves a short message untouched", () => {
    expect(toSpokenSummary("Just the one sentence.")).toBe("Just the one sentence.");
  });
});
