import { AwsDynamoDocument } from "../../../src/server/aws/AwsDynamoDocument";
import { DynamoFixedWindowRateLimiter } from "../../../src/server/judge/aws/dynamo";
import { findMission } from "../../../src/server/procurement";
import { ProcurementOrchestrator } from "../../../src/server/procurement";
import { DynamoProcurementSessionStore } from "../../../src/server/procurement/aws";
import { EmbeddedMetricFormatSink } from "../../../src/server/procurement/metrics";
import { AwsConnectWebRtcContactPort } from "../../../src/server/webrtc/AwsConnectWebRtcContactPort";
import { DynamoVoiceSessionStore } from "../../../src/server/webrtc/aws/DynamoVoiceSessionStore";
import {
  DisabledConnectWebRtcContactPort,
  VoiceSessionService,
  type ConnectWebRtcContactPort,
} from "../../../src/server/webrtc";

/**
 * The protected endpoint that starts a WebRTC voice session.
 *
 * This is the only route from a browser to Amazon Connect, and it is why the
 * browser never needs an AWS credential.
 *
 * The request body may contain exactly one thing: `missionId`.
 *
 * The PROCUREMENT SESSION IS CREATED HERE, server-side, and its id is returned
 * with the grant. An earlier design had the browser create a run and post its
 * id, which could not work: the portal's run lived in that browser's in-memory
 * store, so this Lambda's DynamoDB lookup found nothing and every request was
 * refused. Owning the run here also means a caller cannot name a session id at
 * all, so there is nothing to guess or collide with.
 *
 * `judgeId` comes from the API Gateway authorizer, never from the body — a
 * caller who could name their own judge id could also reset their own rate
 * limit. If the authorizer produced no identity, the request is refused: an
 * unauthenticated path to a billable contact is the one failure mode that must
 * not exist.
 *
 * The response carries only the projected grant `VoiceSessionService` built,
 * plus the session id. The raw Connect response never leaves the Lambda.
 */

type HttpEvent = {
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: { method?: string };
    authorizer?: {
      jwt?: { claims?: Record<string, unknown> };
      lambda?: Record<string, unknown>;
    };
  };
};

type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function optional(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function json(statusCode: number, body: unknown, origin: string): HttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Reads the caller's identity from the authorizer context only.
 *
 * Supports a JWT authorizer (`sub`) and a Lambda authorizer that sets
 * `judgeId`. Anything else — including a body that helpfully contains a
 * `judgeId` — yields an empty string, which the service refuses.
 */
export function judgeIdFrom(event: HttpEvent): string {
  const authorizer = event.requestContext?.authorizer;
  const fromJwt = authorizer?.jwt?.claims?.sub;
  if (typeof fromJwt === "string" && fromJwt.trim().length > 0) return fromJwt.trim();

  const fromLambda = authorizer?.lambda?.judgeId;
  if (typeof fromLambda === "string" && fromLambda.trim().length > 0) {
    return fromLambda.trim();
  }
  return "";
}

/** Accepts the one permitted field and nothing else. */
export function readStartRequest(event: HttpEvent): { missionId: string } | null {
  if (typeof event.body !== "string" || event.body.length === 0) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const missionId = (parsed as Record<string, unknown>).missionId;
  if (typeof missionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(missionId)) {
    return null;
  }
  /*
   * Shape-checked here, and checked against the closed mission list below. A
   * mission the server does not know is refused before anything is created.
   */
  return { missionId };
}

function contactPort(): ConnectWebRtcContactPort {
  if (process.env.WEBRTC_ENABLED !== "true") {
    return new DisabledConnectWebRtcContactPort();
  }
  const instanceId = optional("CONNECT_INSTANCE_ID");
  const contactFlowId = optional("CONNECT_WEBRTC_FLOW_ID");
  if (instanceId.length === 0 || contactFlowId.length === 0) {
    // Half-configured is refused, not attempted.
    return new DisabledConnectWebRtcContactPort();
  }
  return new AwsConnectWebRtcContactPort({
    instanceId,
    contactFlowId,
    region: optional("AWS_REGION") || undefined,
  });
}

type VoiceSessionDependencies = {
  service: VoiceSessionService;
  /** Creates and owns the procurement run this voice contact belongs to. */
  orchestrator: ProcurementOrchestrator;
  now: () => Date;
};

function buildDependencies(): VoiceSessionDependencies {
  const tableName = required("PROCUREMENT_TABLE");
  const dynamo = new AwsDynamoDocument({ region: optional("AWS_REGION") || undefined });

  const sessions = new DynamoProcurementSessionStore(dynamo, tableName);

  return {
    service: new VoiceSessionService({
      enabled: process.env.WEBRTC_ENABLED === "true",
      contacts: contactPort(),
      store: new DynamoVoiceSessionStore(dynamo, tableName),
      rateLimiter: new DynamoFixedWindowRateLimiter(
        dynamo,
        tableName,
        Number.parseInt(optional("VOICE_SESSIONS_PER_HOUR") || "3", 10),
        60 * 60 * 1000,
      ),
    }),
    orchestrator: new ProcurementOrchestrator({
      sessions,
      // EMF on stdout: CloudWatch extracts the metrics, so no AWS call and no
      // SDK client on the path of a request that is about to start a contact.
      metrics: new EmbeddedMetricFormatSink(),
      channel: "connect-webrtc",
    }),
    now: () => new Date(),
  };
}

let dependencies: VoiceSessionDependencies | null = null;

export function createHandler(overrides: Partial<VoiceSessionDependencies> = {}) {
  return async function voiceSessionHandler(event: HttpEvent): Promise<HttpResponse> {
    const origin = optional("ALLOWED_ORIGIN") || "null";
    const method = event.requestContext?.http?.method;
    if (method !== "POST") {
      return json(405, { status: "REFUSED", reason: "METHOD_NOT_ALLOWED" }, origin);
    }

    const judgeId = judgeIdFrom(event);
    if (judgeId.length === 0) {
      return json(
        401,
        { status: "REFUSED", reason: "IDENTITY_MISSING", message: "Not authenticated." },
        origin,
      );
    }

    const request = readStartRequest(event);
    if (!request) {
      return json(
        400,
        { status: "REFUSED", reason: "IDENTITY_MISSING", message: "Malformed request." },
        origin,
      );
    }

    try {
      dependencies ??= buildDependencies();
      const resolved = { ...dependencies, ...overrides };

      if (!findMission(request.missionId)) {
        return json(
          404,
          {
            status: "REFUSED",
            reason: "SESSION_EXPIRED",
            message: "That mission does not exist.",
          },
          origin,
        );
      }

      /*
       * Create the run first. Its expiry is then the authority on how long the
       * voice contact may live, so a contact can never outlive the run it
       * belongs to.
       */
      const session = await resolved.orchestrator.startSession(request.missionId);

      const result = await resolved.service.start({
        judgeId,
        sessionId: session.sessionId,
        missionId: session.missionId,
        procurementSessionExpiresAt: session.expiresAt,
        now: resolved.now(),
      });

      if (result.status === "REFUSED") {
        console.log(
          JSON.stringify({
            event: "VOICE_SESSION_REFUSED",
            sessionId: session.sessionId,
            reason: result.reason,
          }),
        );
        return json(result.reason === "RATE_LIMITED" ? 429 : 409, result, origin);
      }

      console.log(
        JSON.stringify({
          event: "VOICE_SESSION_STARTED",
          sessionId: session.sessionId,
        }),
      );
      /*
       * The projected grant plus the server-created session id, which the
       * portal needs to read the run report afterwards. The raw Connect
       * response stays here.
       */
      return json(
        200,
        { status: "STARTED", grant: result.grant, sessionId: session.sessionId },
        origin,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "VOICE_SESSION_ERROR",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return json(
        502,
        {
          status: "REFUSED",
          reason: "UPSTREAM_UNAVAILABLE",
          message: "The voice service is unavailable.",
        },
        origin,
      );
    }
  };
}

export const handler = createHandler();
