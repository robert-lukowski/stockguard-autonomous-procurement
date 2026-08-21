import type { CallAuthorization, SupplierCallRequest } from "./types";

export class CallSafetyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "REAL_CALLS_DISABLED"
      | "AUTHORIZATION_EXPIRED"
      | "WORKFLOW_MISMATCH"
      | "SUPPLIER_NOT_ALLOWED"
      | "NUMBER_NOT_ALLOWED"
      | "CONSENT_MISSING"
      | "CALL_LIMIT_INVALID"
      | "SYNTHETIC_SIMULATOR_DISABLED"
      | "SYNTHETIC_SIMULATOR_NUMBER_MISMATCH"
      | "SYNTHETIC_PROFILE_NOT_ALLOWED"
      | "SYNTHETIC_ROUTING_INVALID"
      | "SYNTHETIC_ROUTING_REQUIRED",
  ) {
    super(message);
    this.name = "CallSafetyError";
  }
}

export function validateCallAuthorization(
  request: SupplierCallRequest,
  authorization: CallAuthorization,
  now = new Date(),
) {
  if (authorization.workflowId !== request.workflowId) {
    throw new CallSafetyError(
      "Call authorization belongs to another workflow",
      "WORKFLOW_MISMATCH",
    );
  }

  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new CallSafetyError(
      "Call authorization has expired",
      "AUTHORIZATION_EXPIRED",
    );
  }

  if (!authorization.allowedSupplierIds.includes(request.supplierId)) {
    throw new CallSafetyError(
      "Supplier is not included in the call authorization",
      "SUPPLIER_NOT_ALLOWED",
    );
  }

  if (!authorization.allowedPhoneNumbers.includes(request.phoneE164)) {
    throw new CallSafetyError(
      "Phone number is not included in the call authorization",
      "NUMBER_NOT_ALLOWED",
    );
  }

  if (!request.consentVerified) {
    throw new CallSafetyError(
      "Recipient consent has not been verified",
      "CONSENT_MISSING",
    );
  }

  if (
    !Number.isInteger(authorization.maximumCalls) ||
    authorization.maximumCalls < 1 ||
    authorization.maximumCalls > 5
  ) {
    throw new CallSafetyError(
      "Authorization call limit must be between 1 and 5",
      "CALL_LIMIT_INVALID",
    );
  }
}
