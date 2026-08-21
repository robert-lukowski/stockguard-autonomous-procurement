import { sha256 } from "../../../security";
import {
  createManagerEscalationRecord,
  type ManagerEscalationAuthorization,
  type ManagerEscalationRequest,
  type ManagerEscalationTask,
} from "../../escalation";
import type {
  JudgeRunStatus,
  JudgeSession,
  StartManagerCallRequest,
  StartManagerCallResponse,
} from "../types";
import { Pbkdf2AccessCodeVerifier } from "./accessCode";
import type {
  JudgeBackendDependencies,
  StoredCallClaim,
  StoredJudgeSession,
} from "./types";

type Clock = () => Date;

function randomOpaqueValue(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function isAllowedPhone(phoneE164: string, allowedCallingCodes: string[]): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phoneE164) &&
    allowedCallingCodes.some((prefix) => phoneE164.startsWith(prefix));
}

function callRegionForPhone(phoneE164: string): ManagerEscalationRequest["region"] | null {
  if (phoneE164.startsWith("+33")) return "FR";
  if (phoneE164.startsWith("+44")) return "GB";
  if (phoneE164.startsWith("+48")) return "PL";
  if (phoneE164.startsWith("+49")) return "DE";
  if (phoneE164.startsWith("+1")) return "US";
  return null;
}

function responseFromClaim(
  claim: StoredCallClaim,
  runtime: StartManagerCallResponse["runtime"],
): StartManagerCallResponse {
  return {
    runId: claim.runId,
    callTaskId: claim.callTaskId ?? "pending-idempotent-claim",
    status: claim.status,
    runtime,
  };
}

export class JudgeBackendError extends Error {
  constructor(
    message: string,
    readonly code:
      | "RATE_LIMITED"
      | "ACCESS_DENIED"
      | "SESSION_INVALID"
      | "SESSION_EXPIRED"
      | "SESSION_CONSUMED"
      | "CONSENT_REQUIRED"
      | "PHONE_NOT_ALLOWED"
      | "WORKFLOW_NOT_ELIGIBLE"
      | "KILL_SWITCH_ACTIVE"
      | "GLOBAL_CALL_BUDGET_EXHAUSTED"
      | "CALL_START_FAILED",
  ) {
    super(message);
  }
}

export class JudgeBackendService {
  private readonly verifier: Pbkdf2AccessCodeVerifier;

  constructor(
    private readonly dependencies: JudgeBackendDependencies,
    private readonly clock: Clock = () => new Date(),
    private readonly sessionTtlMs = 15 * 60 * 1000,
    private readonly allowedCallingCodes = ["+1", "+33", "+44", "+48", "+49"],
    private readonly runtime: StartManagerCallResponse["runtime"] = "MOCK",
  ) {
    this.verifier = new Pbkdf2AccessCodeVerifier(dependencies.secretStore);
  }

  async createSession(accessCode: string, requesterKey: string): Promise<JudgeSession> {
    const now = this.clock();
    if (!(await this.dependencies.rateLimiter.allow(requesterKey, now))) {
      throw new JudgeBackendError("Too many Judge Mode authorization attempts", "RATE_LIMITED");
    }
    if (!(await this.verifier.verify(accessCode))) {
      throw new JudgeBackendError("Judge Mode access denied", "ACCESS_DENIED");
    }

    const sessionId = `judge-${randomOpaqueValue(12)}`;
    const sessionToken = randomOpaqueValue(32);
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString();
    // The backend mints the run. The browser never supplies one, so it can
    // never manufacture workflow eligibility.
    const prepared = await this.dependencies.runPreparation.prepareRun(sessionId);
    await this.dependencies.sessionStore.create({
      sessionId,
      runId: prepared.runId,
      tokenHash: await sha256(sessionToken),
      issuedAt: now.toISOString(),
      expiresAt,
      status: "ACTIVE",
      claims: {},
    });
    return {
      sessionId,
      sessionToken,
      expiresAt,
      remainingCalls: 1,
      mode: this.runtime,
      runId: prepared.runId,
      scenario: {
        organizationName: prepared.context.organizationName,
        sku: prepared.context.sku,
        requiredQuantity: prepared.context.requiredQuantity,
        stockoutAt: prepared.context.stockoutAt,
        rejectedOffers: prepared.context.rejectedOffers.map((offer) => ({
          supplierName: offer.supplierName,
          failedChecks: [...offer.failedChecks],
          requiresHumanChecks: [...offer.requiresHumanChecks],
        })),
      },
    };
  }

  /**
   * Loads a session bound to `runId`.
   *
   * An unknown session, a wrong token, a revoked session and a runId this
   * session does not own all collapse to the same SESSION_INVALID error, so a
   * caller cannot probe for runs or distinguish "wrong token" from "no such
   * session". Expiry keeps its own code because the holder of a valid token
   * already knows the session existed, and the UI needs to tell a judge to
   * re-authorize rather than reporting a generic failure.
   */
  private async authenticateForRun(
    sessionId: string,
    sessionToken: string,
    runId: string,
    now: Date,
  ): Promise<StoredJudgeSession> {
    const session = await this.dependencies.sessionStore.getSession(sessionId);
    const tokenMatches =
      session !== null && session.tokenHash === (await sha256(sessionToken));
    if (!session || !tokenMatches || session.status === "REVOKED") {
      throw new JudgeBackendError("Judge session is invalid", "SESSION_INVALID");
    }
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      throw new JudgeBackendError("Judge session has expired", "SESSION_EXPIRED");
    }
    if (session.runId !== runId) {
      throw new JudgeBackendError("Judge session is invalid", "SESSION_INVALID");
    }
    return session;
  }

  async startManagerCall(
    sessionId: string,
    sessionToken: string,
    request: StartManagerCallRequest,
  ): Promise<StartManagerCallResponse> {
    if (!request.explicitConsent) {
      throw new JudgeBackendError("Explicit consent is required", "CONSENT_REQUIRED");
    }
    if (!isAllowedPhone(request.phoneE164, this.allowedCallingCodes)) {
      throw new JudgeBackendError("Phone number or country is not allowed", "PHONE_NOT_ALLOWED");
    }
    const callRegion = callRegionForPhone(request.phoneE164);
    if (!callRegion) {
      throw new JudgeBackendError("Phone number or country is not allowed", "PHONE_NOT_ALLOWED");
    }
    if (await this.dependencies.killSwitch.isActive()) {
      throw new JudgeBackendError("Global call kill switch is active", "KILL_SWITCH_ACTIVE");
    }
    // A session may only act on the run the backend bound to it. Checked
    // before the context lookup so an arbitrary or probed runId is rejected
    // without revealing whether it exists.
    await this.authenticateForRun(sessionId, sessionToken, request.runId, this.clock());
    const context = await this.dependencies.escalationContext.getEscalationContext(request.runId);
    if (!context) {
      throw new JudgeBackendError(
        "Workflow is not in HUMAN_ESCALATION_REQUIRED",
        "WORKFLOW_NOT_ELIGIBLE",
      );
    }

    const now = this.clock();
    const tokenHash = await sha256(sessionToken);
    const claim = await this.dependencies.sessionStore.claimCall({
      sessionId,
      tokenHash,
      idempotencyKey: request.idempotencyKey,
      runId: request.runId,
      phoneHash: await sha256(request.phoneE164),
      locale: request.locale,
      consentRecordedAt: now.toISOString(),
      now: now.toISOString(),
    });
    if (claim.kind === "DUPLICATE") return responseFromClaim(claim.claim, this.runtime);
    if (claim.kind === "NOT_FOUND" || claim.kind === "TOKEN_INVALID" || claim.kind === "REVOKED") {
      throw new JudgeBackendError("Judge session is invalid", "SESSION_INVALID");
    }
    if (claim.kind === "EXPIRED") {
      throw new JudgeBackendError("Judge session has expired", "SESSION_EXPIRED");
    }
    if (claim.kind === "CONSUMED") {
      throw new JudgeBackendError("Judge session call has already been consumed", "SESSION_CONSUMED");
    }
    if (!(await this.dependencies.callBudget.claim())) {
      await this.dependencies.sessionStore.completeClaim(sessionId, request.idempotencyKey, {
        status: "FAILED",
        callTaskId: null,
      });
      throw new JudgeBackendError("Global call budget is exhausted", "GLOBAL_CALL_BUDGET_EXHAUSTED");
    }

    const escalationRequest: ManagerEscalationRequest = {
      runId: request.runId,
      sessionId,
      attemptNumber: 1,
      idempotencyKey: request.idempotencyKey,
      phoneE164: request.phoneE164,
      region: callRegion,
      locale: request.locale,
      consentConfirmed: true,
      context,
    };
    const authorization: ManagerEscalationAuthorization = {
      sessionId,
      accessCodeVerifiedServerSide: true,
      issuedAt: claim.session.issuedAt,
      expiresAt: claim.session.expiresAt,
      allowedPhoneE164: request.phoneE164,
      maximumCalls: 1,
      consentRecordedAt: now.toISOString(),
      killSwitchActive: false,
    };

    let task: ManagerEscalationTask;
    try {
      task = await this.dependencies.managerCalls.startManagerEscalation(
        escalationRequest,
        authorization,
      );
    } catch {
      await this.dependencies.sessionStore.completeClaim(sessionId, request.idempotencyKey, {
        status: "FAILED",
        callTaskId: null,
      });
      throw new JudgeBackendError("Manager call failed to start", "CALL_START_FAILED");
    }

    const status: StoredCallClaim["status"] =
      task.status === "completed"
        ? "COMPLETED"
        : task.status === "in_progress"
          ? "CALLING"
          : task.status === "failed"
            ? "FAILED"
            : "QUEUED";
    await this.dependencies.sessionStore.completeClaim(sessionId, request.idempotencyKey, {
      status,
      callTaskId: task.callId,
    });
    return {
      runId: request.runId,
      callTaskId: task.callId,
      status,
      runtime: this.runtime,
    };
  }

  /**
   * Session-scoped read of the one run this session owns.
   *
   * Fail-closed in every direction: an unknown session, a wrong token, an
   * expired session, or a runId this session is not bound to all raise
   * SESSION_INVALID, so arbitrary runId probing reveals nothing. The terminal
   * manager result is surfaced only once it has actually been recorded, and
   * `runtime` is reported exactly as configured — never inferred.
   */
  async getRunStatus(
    sessionId: string,
    sessionToken: string,
    runId: string,
  ): Promise<JudgeRunStatus> {
    const session = await this.authenticateForRun(
      sessionId,
      sessionToken,
      runId,
      this.clock(),
    );

    const claim = Object.values(session.claims).find((entry) => entry.runId === runId);
    const pending = (
      state: JudgeRunStatus["state"],
    ): JudgeRunStatus => ({
      runId,
      state,
      terminal: false,
      runtime: this.runtime,
      manager: null,
    });

    if (!claim) return pending("HUMAN_ESCALATION_REQUIRED");
    if (claim.status === "FAILED") {
      return { ...pending("FAILED"), terminal: true };
    }

    const task = await this.dependencies.managerResults.read(runId);
    if (!task) return pending("MANAGER_CALLING");

    const record = createManagerEscalationRecord(runId, claim.locale, task);
    if (!record) {
      // Answered but unusable: bad schema, or a decision with no verified
      // evidence. Quarantined into human review, never into a decision.
      return { ...pending("HUMAN_REVIEW"), terminal: true };
    }

    return {
      runId,
      state:
        record.effectiveDecision === "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL"
          ? "AUTHENTICATED_APPROVAL_REQUIRED"
          : "MANAGER_RESPONSE_RECEIVED",
      terminal: true,
      runtime: this.runtime,
      manager: {
        callId: record.callId,
        outcome: record.outcome,
        rawDecision: record.rawDecision,
        effectiveDecision: record.effectiveDecision,
        restrictedActionsRequested: [...record.restrictedActionsRequested],
        preferredContactAt: record.preferredContactAt,
        evidenceStatus: record.evidenceStatus,
        evidenceExcerpt: record.evidenceExcerpt,
        summary: record.summary,
        policyChanged: false,
        orderCreated: false,
      },
    };
  }
}
