import { describe, expect, it } from "vitest";
import type {
  ManagerEscalationPort,
  ManagerEscalationTask,
} from "../../escalation";
import {
  canonicalJudgeEscalationContext,
  createTestAccessCodeSecret,
  FixedWindowRateLimiter,
  InMemoryGlobalCallBudget,
  InMemoryJudgeSessionStore,
  InMemoryManagerResultSink,
  JudgeBackendService,
  StaticAccessCodeSecretStore,
  StaticKillSwitch,
  SyntheticJudgeRunPreparer,
} from ".";

const code = "test-only-judge-code";

function managerTask(
  callId: string,
  overrides: Partial<ManagerEscalationTask> = {},
): ManagerEscalationTask {
  return {
    callId,
    status: "completed",
    outcome: "ANSWERED",
    taskCompleted: true,
    structuredResult: {
      decision: "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
      preferredContactAt: null,
      restrictedActionsRequested: ["INCREASE_BUDGET"],
      optOutRequested: false,
      summary: "Manager asked to increase the budget and buy anyway",
    },
    evidence: ["Synthetic manager response"],
    fieldEvidence: {
      decision: {
        field: "decision",
        source: "transcript",
        excerpt: "Increase the budget and buy anyway",
        verified: true,
      },
    },
    schemaValidation: { valid: true, issues: [] },
    ...overrides,
  };
}

async function fixture(runtime: "LIVE_CALLE" | "MOCK" = "MOCK") {
  const secret = await createTestAccessCodeSecret(
    code,
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
  );
  const preparer = new SyntheticJudgeRunPreparer();
  const results = new InMemoryManagerResultSink();
  const managerCalls: ManagerEscalationPort = {
    async startManagerEscalation(request) {
      return managerTask(`call-${request.runId}`);
    },
  };
  const service = new JudgeBackendService(
    {
      secretStore: new StaticAccessCodeSecretStore(secret),
      sessionStore: new InMemoryJudgeSessionStore(),
      rateLimiter: new FixedWindowRateLimiter(50),
      callBudget: new InMemoryGlobalCallBudget(10),
      killSwitch: new StaticKillSwitch(false),
      escalationContext: preparer,
      managerCalls,
      runPreparation: preparer,
      managerResults: results,
    },
    () => new Date("2026-08-21T10:00:00Z"),
    15 * 60 * 1000,
    ["+1", "+33", "+44", "+48", "+49"],
    runtime,
  );
  return { service, results };
}

async function startedSession(runtime: "LIVE_CALLE" | "MOCK" = "MOCK") {
  const { service, results } = await fixture(runtime);
  const session = await service.createSession(code, "requester-1");
  await service.startManagerCall(session.sessionId, session.sessionToken, {
    runId: session.runId,
    phoneE164: "+48500100200",
    locale: "pl-PL",
    explicitConsent: true,
    idempotencyKey: `${session.sessionId}:manager:1`,
  });
  return { service, results, session };
}

describe("server-owned judge run", () => {
  it("mints the runId itself and never accepts a browser-supplied one", async () => {
    const { service } = await fixture();
    const session = await service.createSession(code, "requester-1");

    expect(session.runId).toMatch(/^judge-run-[A-Za-z0-9_-]+$/);
    expect(session.scenario.rejectedOffers).toHaveLength(3);
    expect(session.scenario.sku).toBe(canonicalJudgeEscalationContext.sku);

    // The public walkthrough's client-generated id must never be eligible.
    await expect(
      service.startManagerCall(session.sessionId, session.sessionToken, {
        runId: "wf-demo-1787328788809",
        phoneE164: "+48500100200",
        locale: "pl-PL",
        explicitConsent: true,
        idempotencyKey: "forged",
      }),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("gives each session a distinct run and refuses cross-session reads", async () => {
    const { service } = await fixture();
    const a = await service.createSession(code, "requester-a");
    const b = await service.createSession(code, "requester-b");

    expect(a.runId).not.toBe(b.runId);
    await expect(
      service.getRunStatus(a.sessionId, a.sessionToken, b.runId),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(
      service.getRunStatus(b.sessionId, b.sessionToken, a.runId),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects a wrong token without revealing whether the run exists", async () => {
    const { service } = await fixture();
    const session = await service.createSession(code, "requester-1");

    await expect(
      service.getRunStatus(session.sessionId, "not-the-token", session.runId),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(
      service.getRunStatus("judge-does-not-exist", session.sessionToken, session.runId),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });
});

describe("getRunStatus", () => {
  it("reports a non-terminal state while no result has been recorded", async () => {
    const { service, session } = await startedSession();

    const status = await service.getRunStatus(
      session.sessionId,
      session.sessionToken,
      session.runId,
    );

    expect(status).toMatchObject({
      state: "MANAGER_CALLING",
      terminal: false,
      manager: null,
      runtime: "MOCK",
    });
  });

  it("converts a restricted spoken request instead of obeying it", async () => {
    const { service, results, session } = await startedSession();
    await results.record(session.runId, managerTask(`call-${session.runId}`));

    const status = await service.getRunStatus(
      session.sessionId,
      session.sessionToken,
      session.runId,
    );

    expect(status.state).toBe("AUTHENTICATED_APPROVAL_REQUIRED");
    expect(status.terminal).toBe(true);
    expect(status.manager).toMatchObject({
      rawDecision: "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
      effectiveDecision: "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL",
      restrictedActionsRequested: ["INCREASE_BUDGET"],
      policyChanged: false,
      orderCreated: false,
    });
  });

  it("keeps the first recorded terminal result when a second one arrives", async () => {
    const { service, results, session } = await startedSession();
    await results.record(session.runId, managerTask("first-call"));
    await results.record(
      session.runId,
      managerTask("second-call", {
        structuredResult: {
          decision: "DECLINE_ESCALATION",
          preferredContactAt: null,
          restrictedActionsRequested: [],
          optOutRequested: true,
          summary: "Replayed with a different answer",
        },
      }),
    );

    const status = await service.getRunStatus(
      session.sessionId,
      session.sessionToken,
      session.runId,
    );

    expect(status.manager?.callId).toBe("first-call");
    expect(status.manager?.effectiveDecision).toBe("REQUIRES_AUTHENTICATED_HUMAN_APPROVAL");
  });

  it("quarantines an answered call whose decision evidence is unverified", async () => {
    const { service, results, session } = await startedSession();
    await results.record(
      session.runId,
      managerTask("unverified-call", {
        fieldEvidence: {
          decision: {
            field: "decision",
            source: "recipient_result",
            excerpt: "Increase the budget and buy anyway",
            verified: false,
          },
        },
      }),
    );

    const status = await service.getRunStatus(
      session.sessionId,
      session.sessionToken,
      session.runId,
    );

    expect(status).toMatchObject({ state: "HUMAN_REVIEW", terminal: true, manager: null });
  });

  it("reports runtime exactly as configured and never infers it", async () => {
    const live = await startedSession("LIVE_CALLE");
    await live.results.record(live.session.runId, managerTask("live-call"));
    const liveStatus = await live.service.getRunStatus(
      live.session.sessionId,
      live.session.sessionToken,
      live.session.runId,
    );

    const mock = await startedSession("MOCK");
    await mock.results.record(mock.session.runId, managerTask("mock-call"));
    const mockStatus = await mock.service.getRunStatus(
      mock.session.sessionId,
      mock.session.sessionToken,
      mock.session.runId,
    );

    expect(liveStatus.runtime).toBe("LIVE_CALLE");
    expect(mockStatus.runtime).toBe("MOCK");
  });
});
