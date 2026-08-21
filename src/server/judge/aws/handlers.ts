import { sha256 } from "../../../security";
import { JudgeBackendError, type JudgeBackendService } from "../backend";
import type { JudgeWebhookService, WebhookIngestionResult } from "../backend";
import type { StartManagerCallRequest } from "../types";
import {
  bearerToken,
  jsonResponse,
  normalizedHeaders,
  parseJsonObject,
  type ApiGatewayRequest,
  type ApiGatewayResponse,
} from "./http";

const supportedLocales = new Set(["de-DE", "fr-FR", "pl-PL", "en-GB", "en-US"]);

function backendErrorResponse(error: JudgeBackendError): ApiGatewayResponse {
  const statusByCode: Record<JudgeBackendError["code"], number> = {
    RATE_LIMITED: 429,
    ACCESS_DENIED: 401,
    SESSION_INVALID: 401,
    SESSION_EXPIRED: 401,
    SESSION_CONSUMED: 409,
    CONSENT_REQUIRED: 400,
    PHONE_NOT_ALLOWED: 400,
    WORKFLOW_NOT_ELIGIBLE: 409,
    KILL_SWITCH_ACTIVE: 503,
    GLOBAL_CALL_BUDGET_EXHAUSTED: 503,
    CALL_START_FAILED: 502,
  };
  return jsonResponse(statusByCode[error.code], { error: error.code });
}

function webhookStatus(result: WebhookIngestionResult): number {
  switch (result) {
    case "REJECTED_AUTHENTICITY":
      return 401;
    case "REJECTED_PAYLOAD":
      return 400;
    case "EVENT_ID_CONFLICT":
      return 409;
    case "DUPLICATE":
      return 200;
    case "IGNORED_NON_TERMINAL":
    case "QUARANTINED_SCHEMA":
    case "ACCEPTED":
      return 202;
  }
}

export function createJudgeHandlers(
  backend: JudgeBackendService,
  webhooks: JudgeWebhookService,
): {
  createSession(event: ApiGatewayRequest): Promise<ApiGatewayResponse>;
  startManagerCall(event: ApiGatewayRequest): Promise<ApiGatewayResponse>;
  ingestWebhook(event: ApiGatewayRequest): Promise<ApiGatewayResponse>;
} {
  return {
    async createSession(event) {
      const body = parseJsonObject(event.body);
      if (!body || typeof body.accessCode !== "string") {
        return jsonResponse(400, { error: "INVALID_REQUEST" });
      }
      try {
        const requesterKey = await sha256(event.requestContext.http.sourceIp);
        const session = await backend.createSession(body.accessCode, requesterKey);
        return jsonResponse(201, session);
      } catch (error) {
        return error instanceof JudgeBackendError
          ? backendErrorResponse(error)
          : jsonResponse(500, { error: "INTERNAL_ERROR" });
      }
    },

    async startManagerCall(event) {
      const sessionId = event.pathParameters?.sessionId;
      const sessionToken = bearerToken(event.headers);
      const body = parseJsonObject(event.body);
      if (
        !sessionId ||
        !sessionToken ||
        !body ||
        typeof body.runId !== "string" ||
        typeof body.phoneE164 !== "string" ||
        typeof body.locale !== "string" ||
        !supportedLocales.has(body.locale) ||
        body.explicitConsent !== true ||
        typeof body.idempotencyKey !== "string"
      ) {
        return jsonResponse(400, { error: "INVALID_REQUEST" });
      }
      const request: StartManagerCallRequest = {
        runId: body.runId,
        phoneE164: body.phoneE164,
        locale: body.locale as StartManagerCallRequest["locale"],
        explicitConsent: true,
        idempotencyKey: body.idempotencyKey,
      };
      try {
        const result = await backend.startManagerCall(
          sessionId,
          sessionToken,
          request,
        );
        return jsonResponse(result.status === "COMPLETED" ? 200 : 202, result);
      } catch (error) {
        return error instanceof JudgeBackendError
          ? backendErrorResponse(error)
          : jsonResponse(500, { error: "INTERNAL_ERROR" });
      }
    },

    async ingestWebhook(event) {
      const result = await webhooks.ingest(
        event.body ?? "",
        normalizedHeaders(event.headers),
      );
      return jsonResponse(webhookStatus(result), { result });
    },
  };
}
