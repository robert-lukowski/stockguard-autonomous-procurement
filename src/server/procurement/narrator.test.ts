import { describe, expect, it } from "vitest";

import {
  DeterministicNarrator,
  narrateSafely,
  narrationOnlyUsesKnownFigures,
  type ConversationNarrator,
  type NarrationRequest,
} from "./narrator";

const request: NarrationRequest = {
  kind: "EVALUATION_EXPLAINED",
  deterministicMessage:
    "Ridgeline Industrial Supply quotes 98.00 USD per unit for 20 units, 1960.00 USD in total.",
  allowedFigures: ["98", "20", "1960"],
  facts: { outcome: "ACCEPTED" },
};

function narratorReturning(text: string): ConversationNarrator {
  return { async narrate() { return text; } };
}

describe("narration guard", () => {
  it("accepts a rewording that uses only figures the tools produced", async () => {
    const result = await narrateSafely(
      narratorReturning("That's 20 units at 98.00 USD each, so 1960.00 USD altogether."),
      request,
    );

    expect(result.mode).toBe("narrated");
    expect(result.message).toContain("1960.00");
  });

  it("falls back to the deterministic message when a figure was invented", async () => {
    const result = await narrateSafely(
      narratorReturning("I found a better price of 45.00 USD per unit for 20 units."),
      request,
    );

    expect(result.mode).toBe("deterministic-fallback");
    expect(result.reason).toBe("unknown-figure");
    expect(result.message).toBe(request.deterministicMessage);
  });

  it("falls back when the narrator throws", async () => {
    const result = await narrateSafely(
      { async narrate() { throw new Error("model unavailable"); } },
      request,
    );

    expect(result.mode).toBe("deterministic-fallback");
    expect(result.reason).toBe("narrator-error");
    expect(result.message).toBe(request.deterministicMessage);
  });

  it("falls back on an empty narration", async () => {
    const result = await narrateSafely(narratorReturning("   "), request);

    expect(result.mode).toBe("deterministic-fallback");
    expect(result.reason).toBe("empty-narration");
  });

  it("treats separator and decimal variants of the same figure as equal", () => {
    expect(narrationOnlyUsesKnownFigures("1,960.00 USD", ["1960"])).toBe(true);
    expect(narrationOnlyUsesKnownFigures("1961 USD", ["1960"])).toBe(false);
  });

  it("uses the deterministic message unchanged by default", async () => {
    const result = await narrateSafely(new DeterministicNarrator(), request);

    expect(result.mode).toBe("narrated");
    expect(result.message).toBe(request.deterministicMessage);
  });
});
