import { describe, expect, it } from "vitest";
import type {
  ManagerEscalationPort,
  ManagerEscalationTask,
} from "../../escalation";
import {
  createTestAccessCodeSecret,
  FixedWindowRateLimiter,
  InMemoryGlobalCallBudget,
  InMemoryJudgeSessionStore,
  JudgeBackendError,
  JudgeBackendService,
  StaticAccessCodeSecretStore,
  StaticKillSwitch,
  type EscalationContextPort,
} from ".";

const code = "test-only-judge-code";
const context: EscalationContextPort = {
  async getEscalationContext(runId) {
    if (runId !== "run-no-offer") return null;
    return {
      organizationName: "Northstar Manufacturing",
      sku: "CF-220",
      requiredQuantity: 8,
      stockoutAt: "2026-08-28T12:00:00+02:00",
      rejectedOffers: [
        {
          supplierName: "NordWerk Supply",
          failedChecks: ["quantity"],
          requiresHumanChecks: [],
        },
      ],
    };
  },
};

function completedTask(runId: string): ManagerEscalationTask {
  return {
    callId: `mock-call-${runId}`,
    status: "completed",
    outcome: "ANSWERED",
    taskCompleted: true,
    structuredResult: {
      decision: "REQUEST_WRITTEN_REPORT",
      preferredContactAt: null,
      restrictedActionsRequested: [],
      optOutRequested: false,
      summary: "Send the report",
    },
    evidence: ["Synthetic manager response"],
    fieldEvidence: {
      decision: {
        field: "decision",
        source: "transcript",
        excerpt: "Please send the written report",
        verified: true,
      },
    },
    schemaValidation: { valid: true, issues: [] },
  };
}

async function serviceFixture(options: { killSwitch?: boolean; callBudget?: number } = {}) {
  const secret = await createTestAccessCodeSecret(
    code,
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
  );
  const sessions = new InMemoryJudgeSessionStore();
  const budget = new InMemoryGlobalCallBudget(options.callBudget ?? 10);
  let calls = 0;
  const managerCalls: ManagerEscalationPort = {
    async startManagerEscalation(request) {
      calls += 1;
      return completedTask(request.runId);
    },
  };
  let current = new Date("2026-08-21T10:00:00Z");
  const service = new JudgeBackendService(
    {
      secretStore: new StaticAccessCodeSecretStore(secret),
      sessionStore: sessions,
      rateLimiter: new FixedWindowRateLimiter(3),
      callBudget: budget,
      killSwitch: new StaticKillSwitch(options.killSwitch ?? false),
      escalationContext: context,
      managerCalls,
    },
    () => current,
  );
  return {
    service,
    sessions,
    budget,
    calls: () => calls,
    advance(minutes: number) {
      current = new Date(current.getTime() + minutes * 60 * 1000);
    },
  };
}

describe("JudgeBackendService", () => {
  it("verifies the access code server-side and creates a short-lived opaque session", async () => {
    const { service, sessions } = await serviceFixture();

    const session = await service.createSession(code, "requester-1");
    const stored = sessions.getForTest(session.sessionId);

    expect(session).toMatchObject({ remainingCalls: 1, mode: "MOCK" });
    expect(session.sessionToken).not.toBe(stored?.tokenHash);
    expect(stored?.expiresAt).toBe("2026-08-21T10:15:00.000Z");
    expect(JSON.stringify(stored)).not.toContain(session.sessionToken);
  });

  it("rejects a wrong code and rate-limits repeated authorization attempts", async () => {
    const { service } = await serviceFixture();

    await expect(service.createSession("wrong-1", "requester-1")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(service.createSession("wrong-2", "requester-1")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(service.createSession("wrong-3", "requester-1")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(service.createSession(code, "requester-1")).rejects.toEqual(
      new JudgeBackendError("Too many Judge Mode authorization attempts", "RATE_LIMITED"),
    );
  });

  it("starts one consented call and deduplicates a repeated submission", async () => {
    const { service, sessions, budget, calls } = await serviceFixture();
    const session = await service.createSession(code, "requester-1");
    const request = {
      runId: "run-no-offer",
      phoneE164: "+48500100200",
      locale: "pl-PL" as const,
      explicitConsent: true as const,
      idempotencyKey: `${session.sessionId}:run-no-offer:manager:1`,
    };

    const first = await service.startManagerCall(
      session.sessionId,
      session.sessionToken,
      request,
    );
    const duplicate = await service.startManagerCall(
      session.sessionId,
      session.sessionToken,
      request,
    );

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ status: "COMPLETED", runtime: "MOCK" });
    expect(calls()).toBe(1);
    expect(budget.usedCalls).toBe(1);
    const stored = sessions.getForTest(session.sessionId);
    expect(stored?.status).toBe("CONSUMED");
    expect(JSON.stringify(stored)).not.toContain(request.phoneE164);
    expect(Object.values(stored?.claims ?? {})[0]?.phoneHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks a second idempotency key for an already consumed session", async () => {
    const { service, calls } = await serviceFixture();
    const session = await service.createSession(code, "requester-1");
    const request = {
      runId: "run-no-offer",
      phoneE164: "+4915112345678",
      locale: "de-DE" as const,
      explicitConsent: true as const,
      idempotencyKey: "first-key",
    };
    await service.startManagerCall(session.sessionId, session.sessionToken, request);

    await expect(
      service.startManagerCall(session.sessionId, session.sessionToken, {
        ...request,
        idempotencyKey: "second-key",
      }),
    ).rejects.toMatchObject({ code: "SESSION_CONSUMED" });
    expect(calls()).toBe(1);
  });

  it("fails before claiming the session when the kill switch is active", async () => {
    const { service, sessions, calls } = await serviceFixture({ killSwitch: true });
    const session = await service.createSession(code, "requester-1");

    await expect(
      service.startManagerCall(session.sessionId, session.sessionToken, {
        runId: "run-no-offer",
        phoneE164: "+441234567890",
        locale: "en-GB",
        explicitConsent: true,
        idempotencyKey: "blocked-key",
      }),
    ).rejects.toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
    expect(calls()).toBe(0);
    expect(sessions.getForTest(session.sessionId)?.status).toBe("ACTIVE");
  });

  it("rejects expired sessions and countries outside the allowlist", async () => {
    const { service, advance, calls } = await serviceFixture();
    const session = await service.createSession(code, "requester-1");

    await expect(
      service.startManagerCall(session.sessionId, session.sessionToken, {
        runId: "run-no-offer",
        phoneE164: "+81312345678",
        locale: "en-GB",
        explicitConsent: true,
        idempotencyKey: "country-blocked",
      }),
    ).rejects.toMatchObject({ code: "PHONE_NOT_ALLOWED" });

    advance(16);
    await expect(
      service.startManagerCall(session.sessionId, session.sessionToken, {
        runId: "run-no-offer",
        phoneE164: "+48500100200",
        locale: "pl-PL",
        explicitConsent: true,
        idempotencyKey: "expired",
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(calls()).toBe(0);
  });
});
