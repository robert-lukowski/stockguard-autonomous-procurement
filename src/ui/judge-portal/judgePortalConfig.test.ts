import { describe, expect, it } from "vitest";

import { resolveJudgePortalConfig } from "./judgePortalConfig";

describe("judge portal configuration", () => {
  it("keeps browser voice off by default", () => {
    expect(resolveJudgePortalConfig(undefined, undefined).webRtcEnabled).toBe(false);
    expect(resolveJudgePortalConfig("", "").webRtcEnabled).toBe(false);
  });

  it("treats anything but an exact \"true\" as off", () => {
    for (const raw of ["TRUE", "1", "yes", "false", " true "]) {
      expect(resolveJudgePortalConfig(raw, "https://example.invalid/session").webRtcEnabled)
        .toBe(false);
    }
  });

  it("stays off when the flag is set but no protected endpoint exists", () => {
    const config = resolveJudgePortalConfig("true", undefined);

    expect(config.webRtcEnabled).toBe(false);
    expect(config.voiceStatus).toContain("no protected session endpoint");
  });

  it("enables the seam only with both the flag and an endpoint", () => {
    const config = resolveJudgePortalConfig("true", " https://example.invalid/session ");

    expect(config.webRtcEnabled).toBe(true);
    expect(config.sessionEndpoint).toBe("https://example.invalid/session");
    expect(config.voiceStatus).toContain("never receives AWS credentials");
  });

  it("never exposes an endpoint while voice is unavailable", () => {
    for (const [flag, endpoint] of [
      [undefined, undefined],
      ["true", undefined],
      ["false", "https://example.invalid/session"],
    ] as Array<[string | undefined, string | undefined]>) {
      expect(resolveJudgePortalConfig(flag, endpoint).sessionEndpoint).toBeNull();
    }
  });
});
