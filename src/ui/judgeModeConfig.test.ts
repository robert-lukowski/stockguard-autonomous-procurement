import { describe, expect, it } from "vitest";
import {
  deriveLocaleFromPhone,
  isSupportedJudgePhone,
  resolveJudgeBackendUrl,
} from "./judgeModeConfig";

describe("resolveJudgeBackendUrl", () => {
  it("is locked by default and for unusable values", () => {
    expect(resolveJudgeBackendUrl(undefined)).toBeNull();
    expect(resolveJudgeBackendUrl("")).toBeNull();
    expect(resolveJudgeBackendUrl("   ")).toBeNull();
    expect(resolveJudgeBackendUrl("not a url")).toBeNull();
  });

  it("refuses plaintext transports that would expose the code and number", () => {
    expect(resolveJudgeBackendUrl("http://judge-api.example.test")).toBeNull();
  });

  it("normalizes a valid HTTPS backend", () => {
    expect(resolveJudgeBackendUrl("https://judge-api.example.test/")).toBe(
      "https://judge-api.example.test",
    );
    expect(resolveJudgeBackendUrl("  https://judge-api.example.test/api/  ")).toBe(
      "https://judge-api.example.test/api",
    );
  });
});

describe("locale derivation", () => {
  it("derives the documented locale for each allowed calling code", () => {
    expect(deriveLocaleFromPhone("+1 415 555 0100")).toBe("en-US");
    expect(deriveLocaleFromPhone("+441234567890")).toBe("en-GB");
    expect(deriveLocaleFromPhone("+33612345678")).toBe("fr-FR");
    expect(deriveLocaleFromPhone("+4915112345678")).toBe("de-DE");
    expect(deriveLocaleFromPhone("+48500100200")).toBe("pl-PL");
  });

  it("returns null for a country the backend does not allow", () => {
    expect(deriveLocaleFromPhone("+81312345678")).toBeNull();
    expect(isSupportedJudgePhone("+81312345678")).toBe(false);
  });

  it("rejects malformed E.164 input", () => {
    expect(isSupportedJudgePhone("48500100200")).toBe(false);
    expect(isSupportedJudgePhone("+48")).toBe(false);
    expect(isSupportedJudgePhone("+0500100200")).toBe(false);
  });
});
