import { describe, expect, it } from "vitest";
import {
  classificationForBackendRuntime,
  runtimeClassifications,
} from "../runtimeClassification";
import { resolveJudgeBackendUrl } from "../judgeModeConfig";

describe("live runtime honesty", () => {
  it("shows a live badge only for a backend-reported LIVE_CALLE runtime", () => {
    expect(classificationForBackendRuntime("LIVE_CALLE")).toBe("LIVE_CALLE_CALL");
    expect(classificationForBackendRuntime("MOCK")).toBe("MOCK_RUNTIME");
  });

  it("cannot produce a live badge from a configured backend URL alone", () => {
    const configured = resolveJudgeBackendUrl("https://judge-api.example.test");
    expect(configured).not.toBeNull();
    // A URL is not a runtime. The only input to the badge is what the backend
    // reported for the run itself.
    expect(classificationForBackendRuntime("MOCK")).toBe("MOCK_RUNTIME");
  });

  it("keeps the classification registry immutable definitions", () => {
    expect(runtimeClassifications.LIVE_CALLE_CALL.available).toBe(false);
    expect(runtimeClassifications.RECORDED_CALLE_EVIDENCE.available).toBe(false);
  });
});
