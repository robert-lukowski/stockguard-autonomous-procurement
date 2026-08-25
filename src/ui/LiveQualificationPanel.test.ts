import { describe, expect, it, vi } from "vitest";
import {
  pollForRecording,
  RECORDING_POLL_INTERVAL_MS,
  RECORDING_POLL_LIMIT,
} from "./liveRecording";
import {
  liveQualificationResultText,
  type LiveQualificationEnvelope,
} from "./liveQualificationResultText";

function envelope(
  outcome: string,
  evidence: "VERIFIED" | "UNVERIFIED" | "NOT_PROVIDED",
): LiveQualificationEnvelope {
  return {
    runtime: "LIVE_CALLE",
    liveCall: {
      callId: "call-real-01",
      outcome,
      taskCompleted: outcome === "ANSWERED",
      attemptCount: 1,
    },
    workflow: {
      purchaseOrder: null,
      decision: {
        rejectedOffers: [{
          offer: {
            commercialTermsChanged: true,
            evidenceStatus: { commercialTermsChanged: evidence },
          },
        }],
      },
    },
  } as unknown as LiveQualificationEnvelope;
}

describe("live qualification result text", () => {
  it("uses neutral wording when a timeout has no structured evidence", () => {
    const text = liveQualificationResultText(
      envelope("TIMEOUT", "NOT_PROVIDED"),
    );

    expect(text).toBe(
      "The live qualification did not return a structured supplier result. No purchase order was created.",
    );
    expect(text).not.toContain("intentionally changes payment terms");
  });

  it("mentions changed terms only when the answered call verifies them", () => {
    expect(liveQualificationResultText(envelope("ANSWERED", "VERIFIED"))).toContain(
      "intentionally changes payment terms",
    );
    expect(liveQualificationResultText(envelope("ANSWERED", "UNVERIFIED"))).not.toContain(
      "intentionally changes payment terms",
    );
  });
});

const recordingReference = {
  workflowId: "live-en-1787659500000-deadbeef",
  startedAt: "2026-08-25T12:05:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("live qualification recording player", () => {
  it("stops bounded polling as soon as the recording is ready", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ status: "PROCESSING" }))
      .mockResolvedValueOnce(
        response({
          status: "READY",
          audioUrl: "https://recordings.example/live.wav?signature=short-lived",
          contentType: "audio/wav",
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollForRecording({
        backendUrl: "https://backend.example/qualification",
        judgePin: "2468",
        reference: recordingReference,
        fetchImpl,
        sleep,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      audioUrl: "https://recordings.example/live.wav?signature=short-lived",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(RECORDING_POLL_INTERVAL_MS);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { "X-Judge-PIN": "2468" },
    });
  });

  it("stops after twenty processing responses", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(response({ status: "PROCESSING" })),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollForRecording({
        backendUrl: "https://backend.example/qualification",
        judgePin: "2468",
        reference: recordingReference,
        fetchImpl,
        sleep,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(RECORDING_POLL_LIMIT);
    expect(sleep).toHaveBeenCalledTimes(RECORDING_POLL_LIMIT - 1);
  });

  it("stops quietly when recording is disabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: "DISABLED" }));

    await expect(
      pollForRecording({
        backendUrl: "https://backend.example/qualification",
        judgePin: "2468",
        reference: recordingReference,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "disabled" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
