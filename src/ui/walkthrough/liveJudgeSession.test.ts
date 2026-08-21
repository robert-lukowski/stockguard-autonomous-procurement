import { describe, expect, it, vi } from "vitest";
import { JudgeModeBackendClient, type JudgeRunStatus, type JudgeSession } from "../../server/judge";
import {
  authorizeJudgeSession,
  livePollPolicy,
  runLiveManagerCall,
} from "./liveJudgeSession";

const session: JudgeSession = {
  sessionId: "judge-1",
  sessionToken: "opaque-token",
  expiresAt: "2026-08-21T10:15:00Z",
  remainingCalls: 1,
  mode: "MOCK",
  runId: "judge-run-abc",
  scenario: {
    organizationName: "Northstar Manufacturing",
    sku: "CF-220",
    requiredQuantity: 8,
    stockoutAt: "2026-08-28T12:00:00+02:00",
    rejectedOffers: [],
  },
};

function status(overrides: Partial<JudgeRunStatus> = {}): JudgeRunStatus {
  return {
    runId: session.runId,
    state: "MANAGER_CALLING",
    terminal: false,
    runtime: "MOCK",
    manager: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function deps(responses: unknown[]) {
  const fetchImplementation = vi.fn();
  for (const body of responses) {
    fetchImplementation.mockResolvedValueOnce(jsonResponse(body));
  }
  const client = new JudgeModeBackendClient({
    baseUrl: "https://judge-api.example.test",
    fetchImplementation,
  });
  return { client, fetchImplementation };
}

describe("live judge authorization", () => {
  it("never transmits the access code when no backend is configured", async () => {
    const fetchImplementation = vi.fn();
    const client = new JudgeModeBackendClient({ fetchImplementation });

    await expect(
      authorizeJudgeSession({ client }, "some-code"),
    ).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("uses the backend-minted runId, not one chosen by the browser", async () => {
    const { client, fetchImplementation } = deps([
      { runId: session.runId, callTaskId: "call-1", status: "QUEUED", runtime: "MOCK" },
      status({ terminal: true, state: "MANAGER_RESPONSE_RECEIVED" }),
    ]);

    await runLiveManagerCall(
      { client, sleep: async () => {} },
      session,
      { phoneE164: "+48500100200", locale: "pl-PL" },
      () => {},
    );

    const [, startInit] = fetchImplementation.mock.calls[0];
    expect(JSON.parse(startInit.body).runId).toBe("judge-run-abc");
    expect(fetchImplementation.mock.calls[1][0]).toContain(
      "/judge/runs/judge-run-abc",
    );
  });
});

describe("bounded polling", () => {
  it("stops immediately on a terminal state", async () => {
    const { client, fetchImplementation } = deps([
      { runId: session.runId, callTaskId: "call-1", status: "QUEUED", runtime: "MOCK" },
      status(),
      status({ terminal: true, state: "AUTHENTICATED_APPROVAL_REQUIRED" }),
    ]);
    const seen: JudgeRunStatus[] = [];

    const result = await runLiveManagerCall(
      { client, sleep: async () => {} },
      session,
      { phoneE164: "+48500100200", locale: "pl-PL" },
      (update) => seen.push(update),
    );

    expect(result.status?.state).toBe("AUTHENTICATED_APPROVAL_REQUIRED");
    expect(result.timedOut).toBe(false);
    expect(seen).toHaveLength(2);
    // start + two polls, then nothing further
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("gives up at the hard timeout instead of polling forever", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ runId: session.runId, callTaskId: "c", status: "QUEUED", runtime: "MOCK" }),
      )
      .mockImplementation(async () => jsonResponse(status()));
    const client = new JudgeModeBackendClient({
      baseUrl: "https://judge-api.example.test",
      fetchImplementation,
    });
    let clock = 0;

    const result = await runLiveManagerCall(
      {
        client,
        sleep: async () => {
          clock += livePollPolicy.intervalMs;
        },
        now: () => clock,
      },
      session,
      { phoneE164: "+48500100200", locale: "pl-PL" },
      () => {},
    );

    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    const maximumPolls = livePollPolicy.timeoutMs / livePollPolicy.intervalMs;
    expect(fetchImplementation.mock.calls.length).toBeLessThanOrEqual(maximumPolls + 1);
  });

  it("stops polling as soon as it is cancelled", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ runId: session.runId, callTaskId: "c", status: "QUEUED", runtime: "MOCK" }),
      )
      .mockImplementation(async () => jsonResponse(status()));
    const client = new JudgeModeBackendClient({
      baseUrl: "https://judge-api.example.test",
      fetchImplementation,
    });
    const signal = { aborted: false };

    const result = await runLiveManagerCall(
      {
        client,
        signal,
        sleep: async () => {
          signal.aborted = true;
        },
      },
      session,
      { phoneE164: "+48500100200", locale: "pl-PL" },
      () => {},
    );

    expect(result).toEqual({ status: null, timedOut: false });
    // start + one poll, then cancelled during the wait
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
