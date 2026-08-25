import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { createHandler } from "./liveCallerHandler";

const now = new Date("2026-08-25T12:05:00.000Z");
const workflowId = "live-en-1787659500000-deadbeef";
const query = {
  recordingWorkflowId: workflowId,
  startedAt: now.toISOString(),
};
const runtimeSecret = {
  CALLE_API_KEY: "test-key",
  QUALIFICATION_PHONE_E164: "+12025550123",
  JUDGE_PIN: "2468",
};

function event(
  method: "GET" | "POST",
  pin?: string,
  queryStringParameters: Record<string, string | undefined> = query,
) {
  return {
    headers: pin ? { "X-Judge-PIN": pin } : {},
    queryStringParameters,
    requestContext: { http: { method } },
  };
}

function body(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function configureRecording(enabled: boolean) {
  vi.stubEnv("RECORDING_ENABLED", enabled ? "true" : "false");
  vi.stubEnv("RECORDING_BUCKET", "private-recordings");
  vi.stubEnv("RECORDING_PREFIX", "connect/qualification/CallRecordings");
  vi.stubEnv("RECORDING_URL_TTL_SECONDS", "300");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("live caller recording endpoint", () => {
  it("rejects GET without the Judge PIN before looking in S3", async () => {
    configureRecording(true);
    const findRecording = vi.fn();
    const handler = createHandler({
      readSecret: vi.fn().mockResolvedValue(runtimeSecret),
      findRecording,
    });

    const response = await handler(event("GET"));

    expect(response.statusCode).toBe(401);
    expect(findRecording).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid lookup", async () => {
    configureRecording(true);
    const handler = createHandler({
      readSecret: vi.fn().mockResolvedValue(runtimeSecret),
      now: () => now,
    });

    const response = await handler(event("GET", "2468", {}));

    expect(response.statusCode).toBe(400);
    expect(body(response)).toEqual({ error: "INVALID_RECORDING_LOOKUP" });
  });

  it("returns DISABLED without touching S3", async () => {
    configureRecording(false);
    const findRecording = vi.fn();
    const handler = createHandler({
      readSecret: vi.fn().mockResolvedValue(runtimeSecret),
      findRecording,
      now: () => now,
    });

    const response = await handler(event("GET", "2468"));

    expect(body(response)).toEqual({ status: "DISABLED" });
    expect(findRecording).not.toHaveBeenCalled();
  });

  it("maps an empty recent window to PROCESSING without starting CALL-E", async () => {
    configureRecording(true);
    const runQualification = vi.fn();
    const handler = createHandler({
      readSecret: vi.fn().mockResolvedValue(runtimeSecret),
      findRecording: vi.fn().mockResolvedValue({
        status: "PROCESSING",
        candidateCount: 0,
      }),
      runQualification,
      now: () => now,
    });

    const response = await handler(event("GET", "2468"));

    expect(body(response)).toEqual({ status: "PROCESSING" });
    expect(runQualification).not.toHaveBeenCalled();
  });

  it("returns READY without logging the presigned URL", async () => {
    configureRecording(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handler = createHandler({
      readSecret: vi.fn().mockResolvedValue(runtimeSecret),
      findRecording: vi.fn().mockResolvedValue({
        status: "READY",
        audioUrl: "https://signed.example/secret-audio-url",
        contentType: "audio/wav",
        recordedAt: now.toISOString(),
        candidateCount: 1,
      }),
      now: () => now,
    });

    const response = await handler(event("GET", "2468"));

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      status: "READY",
      audioUrl: "https://signed.example/secret-audio-url",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-audio-url");
  });

  it("keeps POST as the only call path and requires PLACE-CALL", async () => {
    configureRecording(true);
    const runQualification = vi.fn().mockResolvedValue({
      runtime: "LIVE_CALLE",
      liveCall: null,
      workflow: { status: "HUMAN_ESCALATION_REQUIRED" },
    });
    const findRecording = vi.fn().mockRejectedValue(new Error("S3 unavailable"));
    const handler = createHandler({
      readSecret: vi.fn().mockResolvedValue(runtimeSecret),
      runQualification,
      findRecording,
      now: () => now,
      createWorkflowId: () => workflowId,
    });

    const denied = await handler(event("POST", "2468"));
    expect(denied.statusCode).toBe(400);
    expect(runQualification).not.toHaveBeenCalled();

    const approvedEvent = event("POST", "2468");
    approvedEvent.headers["X-Confirm"] = "PLACE-CALL";
    const approved = await handler(approvedEvent);

    expect(approved.statusCode).toBe(200);
    expect(runQualification).toHaveBeenCalledTimes(1);
    expect(findRecording).not.toHaveBeenCalled();
    expect(body(approved)).toMatchObject({
      workflow: { status: "HUMAN_ESCALATION_REQUIRED" },
      recordingLookup: { workflowId, startedAt: now.toISOString() },
    });
  });

  it("keeps the production CALL-E execution at one attempt", () => {
    const source = readFileSync(__filename.replace(/\.test\.ts$/, ".ts"), "utf8");
    expect(source).toContain("maximumAttempts: 1");
  });
});
