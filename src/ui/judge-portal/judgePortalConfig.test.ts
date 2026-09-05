import { describe, expect, it } from "vitest";

import { resolveJudgePortalConfig } from "./judgePortalConfig";

describe("judge portal configuration", () => {
  it("keeps browser voice off by default", () => {
    expect(resolveJudgePortalConfig(undefined, undefined, undefined).webRtcEnabled).toBe(false);
    expect(resolveJudgePortalConfig("", "", "").webRtcEnabled).toBe(false);
  });

  it("treats anything but an exact \"true\" as off", () => {
    for (const raw of ["TRUE", "1", "yes", "false", " true "]) {
      expect(
        resolveJudgePortalConfig(
          raw,
          "https://example.invalid/session",
          "https://example.invalid/login",
        ).webRtcEnabled,
      ).toBe(false);
    }
  });

  it("requires both the session and sign-in endpoints, not just one", () => {
    // Either alone would show a Start button that can only ever return 401.
    for (const [session, login] of [
      [undefined, undefined],
      ["https://example.invalid/session", undefined],
      [undefined, "https://example.invalid/login"],
    ] as Array<[string | undefined, string | undefined]>) {
      const config = resolveJudgePortalConfig("true", session, login);

      expect(config.webRtcEnabled).toBe(false);
      expect(config.sessionEndpoint).toBeNull();
      expect(config.loginEndpoint).toBeNull();
    }
  });

  it("enables the seam only with the flag and both endpoints", () => {
    const config = resolveJudgePortalConfig(
      "true",
      " https://example.invalid/session ",
      " https://example.invalid/login ",
    );

    expect(config.webRtcEnabled).toBe(true);
    expect(config.sessionEndpoint).toBe("https://example.invalid/session");
    expect(config.loginEndpoint).toBe("https://example.invalid/login");
    expect(config.voiceStatus).toContain("access code");
  });

  it("never exposes an endpoint while voice is unavailable", () => {
    for (const [flag, endpoint] of [
      [undefined, undefined],
      ["true", undefined],
      ["false", "https://example.invalid/session"],
    ] as Array<[string | undefined, string | undefined]>) {
      const config = resolveJudgePortalConfig(flag, endpoint, "https://example.invalid/login");
      expect(config.sessionEndpoint).toBeNull();
      expect(config.loginEndpoint).toBeNull();
    }
  });
});
