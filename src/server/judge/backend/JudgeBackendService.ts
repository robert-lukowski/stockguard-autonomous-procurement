import { sha256 } from "../../../security";
import type {
  ManagerEscalationAuthorization,
  ManagerEscalationRequest,
  ManagerEscalationTask,
} from "../../escalation";
import type {
  JudgeSession,
  StartManagerCallRequest,
  StartManagerCallResponse,
} from "../types";
import { Pbkdf2AccessCodeVerifier } from "./accessCode";
import type { JudgeBackendDependencies, StoredCallClaim } from "./types";

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
    await this.dependencies.sessionStore.create({
      sessionId,
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
    };
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
    if (await this.dependencies.killSwitch.isActive()) {
      throw new JudgeBackendError("Global call kill switch is active", "KILL_SWITCH_ACTIVE");
    }
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
}
