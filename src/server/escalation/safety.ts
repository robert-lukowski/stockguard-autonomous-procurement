import type {
  ManagerEscalationAuthorization,
  ManagerEscalationRequest,
} from "./types";

export class ManagerEscalationSafetyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "SESSION_MISMATCH"
      | "SESSION_EXPIRED"
      | "ACCESS_CODE_NOT_VERIFIED"
      | "PHONE_NOT_ALLOWED"
      | "CONSENT_MISSING"
      | "KILL_SWITCH_ACTIVE"
      | "REAL_CALLS_DISABLED"
      | "CALL_LIMIT_INVALID",
  ) {
    super(message);
  }
}

export function validateManagerEscalationAuthorization(
  request: ManagerEscalationRequest,
  authorization: ManagerEscalationAuthorization,
  now = new Date(),
): void {
  if (request.sessionId !== authorization.sessionId) {
    throw new ManagerEscalationSafetyError("Judge session does not match", "SESSION_MISMATCH");
  }
  if (!authorization.accessCodeVerifiedServerSide) {
    throw new ManagerEscalationSafetyError("Access code was not verified by the backend", "ACCESS_CODE_NOT_VERIFIED");
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new ManagerEscalationSafetyError("Judge session has expired", "SESSION_EXPIRED");
  }
  if (request.phoneE164 !== authorization.allowedPhoneE164) {
    throw new ManagerEscalationSafetyError("Phone number is outside the session allowlist", "PHONE_NOT_ALLOWED");
  }
  if (!request.consentConfirmed || !authorization.consentRecordedAt) {
    throw new ManagerEscalationSafetyError("Explicit call consent is required", "CONSENT_MISSING");
  }
  if (authorization.killSwitchActive) {
    throw new ManagerEscalationSafetyError("Global call kill switch is active", "KILL_SWITCH_ACTIVE");
  }
  if (authorization.maximumCalls !== 1 || request.attemptNumber !== 1) {
    throw new ManagerEscalationSafetyError("Judge sessions allow exactly one call attempt", "CALL_LIMIT_INVALID");
  }
}
