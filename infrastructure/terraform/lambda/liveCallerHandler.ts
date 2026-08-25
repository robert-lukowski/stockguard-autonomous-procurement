import { randomUUID, timingSafeEqual } from "node:crypto";

import { buildQualificationInput } from "../../../src/demo/qualificationInput";
import { CallEApiAdapter } from "../../../src/server/calle";
import {
  defaultCallExecutionPolicy,
  InMemoryWorkflowRunStore,
  MockPurchaseOrderAdapter,
  ProcurementWorkflow,
} from "../../../src/server/workflow";
import {
  findRecentRecording,
  InvalidRecordingLookupError,
  isRecordingConfigured,
  parseRecordingLookupReference,
  recordingConfigurationFromEnvironment,
} from "./recordingLookup";

type FunctionUrlEvent = {
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      method?: string;
    };
  };
};

type FunctionUrlResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type RuntimeSecret = {
  CALLE_API_KEY: string;
  QUALIFICATION_PHONE_E164: string;
  JUDGE_PIN: string;
};

type SecretValueResponse = {
  SecretString?: string;
};

type SecretsClient = {
  send(command: unknown): Promise<SecretValueResponse>;
};

let secretsClientPromise: Promise<{
  client: SecretsClient;
  command: new (input: { SecretId: string }) => unknown;
}> | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function header(event: FunctionUrlEvent, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return "";
}

function json(statusCode: number, body: unknown): FunctionUrlResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseRuntimeSecret(secretString: string): RuntimeSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error("CALL-E runtime secret must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CALL-E runtime secret must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const apiKey = record.CALLE_API_KEY;
  const phone = record.QUALIFICATION_PHONE_E164;
  const judgePin = record.JUDGE_PIN;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("CALL-E runtime secret is missing CALLE_API_KEY");
  }
  if (typeof phone !== "string" || !/^\+1\d{10}$/.test(phone.trim())) {
    throw new Error("CALL-E runtime secret has an invalid QUALIFICATION_PHONE_E164");
  }
  if (typeof judgePin !== "string" || judgePin.trim().length < 4) {
    throw new Error("CALL-E runtime secret is missing JUDGE_PIN");
  }
  return {
    CALLE_API_KEY: apiKey.trim(),
    QUALIFICATION_PHONE_E164: phone.trim(),
    JUDGE_PIN: judgePin,
  };
}

async function awsSecretsClient() {
  if (!secretsClientPromise) {
    secretsClientPromise = import("@aws-sdk/client-secrets-manager").then((sdk) => ({
      client: new sdk.SecretsManagerClient({}) as SecretsClient,
      command: sdk.GetSecretValueCommand as new (input: { SecretId: string }) => unknown,
    }));
  }
  return secretsClientPromise;
}

async function readRuntimeSecret(): Promise<RuntimeSecret> {
  const secretId = required("CALLE_SECRET_ID");
  const { client, command: GetSecretValueCommand } = await awsSecretsClient();
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!response.SecretString) throw new Error("CALL-E runtime secret has no SecretString");
  return parseRuntimeSecret(response.SecretString);
}

function numberEnv(name: string): number {
  const value = Number.parseInt(required(name), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function runLiveQualification(
  runtimeSecret: RuntimeSecret,
  workflowId: string,
  now: Date,
) {
    const quantity = numberEnv("QUALIFICATION_QUANTITY");
    const input = buildQualificationInput({
      workflowId,
      phoneE164: runtimeSecret.QUALIFICATION_PHONE_E164,
      sku: required("QUALIFICATION_SKU"),
      quantity,
      requiredBy: required("QUALIFICATION_REQUIRED_BY"),
      now,
    });

    const supplierCalls = new CallEApiAdapter({
      apiKey: runtimeSecret.CALLE_API_KEY,
      baseUrl: process.env.CALLE_BASE_URL?.trim() || undefined,
      realCallsEnabled: true,
      syntheticSupplierSimulator: {
        enabled: true,
        phoneE164: runtimeSecret.QUALIFICATION_PHONE_E164,
        region: "US",
        allowedProfileIds: ["EN_SUPPLIER"],
        routingMode: "fixed-qualification",
      },
    });
    const oneCallPolicy = {
      ...defaultCallExecutionPolicy,
      maximumAttempts: 1,
    };
    const workflow = new ProcurementWorkflow(
      supplierCalls,
      new MockPurchaseOrderAdapter(),
      () => new Date(),
      undefined,
      new InMemoryWorkflowRunStore(),
      oneCallPolicy,
    );

    console.log(JSON.stringify({ event: "CALLE_REQUEST_STARTED", workflowId }));
    const result = await workflow.run(input);
    const callEvent = result.auditTimeline.find((entry) => entry.type === "CALL_COMPLETED");
    const liveCall = callEvent
      ? {
          callId: typeof callEvent.evidence.callId === "string" ? callEvent.evidence.callId : null,
          outcome: typeof callEvent.evidence.outcome === "string" ? callEvent.evidence.outcome : null,
          taskCompleted:
            typeof callEvent.evidence.taskCompleted === "boolean"
              ? callEvent.evidence.taskCompleted
              : null,
          attemptCount:
            typeof callEvent.evidence.attemptCount === "number"
              ? callEvent.evidence.attemptCount
              : null,
        }
      : null;

    if (liveCall?.callId) {
      console.log(
        JSON.stringify({
          event: "CALLE_TERMINAL_STATUS",
          workflowId,
          callId: liveCall.callId,
          outcome: liveCall.outcome,
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "WORKFLOW_COMPLETED",
        workflowId,
        decision: result.status,
      }),
    );

    return {
      runtime: "LIVE_CALLE",
      liveCall,
      workflow: result,
    } as const;
}

type LiveCallerDependencies = {
  readSecret: typeof readRuntimeSecret;
  runQualification: typeof runLiveQualification;
  findRecording: typeof findRecentRecording;
  now: () => Date;
  createWorkflowId: (now: Date) => string;
};

/**
 * Public Function URL handler for the final judge E2E path.
 *
 * POST is the only path that can place a call and still requires the explicit
 * PLACE-CALL confirmation. GET is a PIN-gated, read-only lookup for the
 * optional recording artifact. Neither request can choose a destination,
 * supplier profile, SKU, quantity, deadline, or credential.
 */
export function createHandler(overrides: Partial<LiveCallerDependencies> = {}) {
  const dependencies: LiveCallerDependencies = {
    readSecret: readRuntimeSecret,
    runQualification: runLiveQualification,
    findRecording: findRecentRecording,
    now: () => new Date(),
    createWorkflowId: (now) => `live-en-${now.getTime()}-${randomUUID().slice(0, 8)}`,
    ...overrides,
  };

  return async function liveCallerHandler(
    event: FunctionUrlEvent,
  ): Promise<FunctionUrlResponse> {
    const method = event.requestContext?.http?.method;
    if (method !== "GET" && method !== "POST") {
      return json(405, { error: "METHOD_NOT_ALLOWED" });
    }
    if (method === "POST" && header(event, "x-confirm") !== "PLACE-CALL") {
      return json(400, { error: "CONFIRMATION_REQUIRED" });
    }

    try {
      const runtimeSecret = await dependencies.readSecret();
      const suppliedPin = header(event, "x-judge-pin");
      if (!suppliedPin || !sameSecret(suppliedPin, runtimeSecret.JUDGE_PIN)) {
        return json(401, { error: "ACCESS_DENIED" });
      }

      const now = dependencies.now();
      if (method === "GET") {
        let reference;
        try {
          reference = parseRecordingLookupReference(event.queryStringParameters, now);
        } catch (error) {
          if (error instanceof InvalidRecordingLookupError) {
            return json(400, { error: "INVALID_RECORDING_LOOKUP" });
          }
          throw error;
        }

        const configuration = recordingConfigurationFromEnvironment();
        if (!configuration) return json(200, { status: "DISABLED" });

        const lookupStartedAt = Date.now();
        console.log(
          JSON.stringify({
            event: "RECORDING_LOOKUP_STARTED",
            workflowId: reference.workflowId,
          }),
        );
        try {
          const recording = await dependencies.findRecording(
            reference,
            configuration,
          );
          const elapsedMs = Date.now() - lookupStartedAt;
          if (recording.status === "PROCESSING") {
            console.log(
              JSON.stringify({
                event: "RECORDING_NOT_READY",
                workflowId: reference.workflowId,
                elapsedMs,
                candidateCount: recording.candidateCount,
                status: recording.status,
              }),
            );
            return json(200, { status: "PROCESSING" });
          }

          console.log(
            JSON.stringify({
              event: "RECORDING_READY",
              workflowId: reference.workflowId,
              elapsedMs,
              candidateCount: recording.candidateCount,
              status: recording.status,
            }),
          );
          return json(200, {
            status: "READY",
            audioUrl: recording.audioUrl,
            contentType: recording.contentType,
            recordedAt: recording.recordedAt,
          });
        } catch {
          console.error(
            JSON.stringify({
              event: "RECORDING_LOOKUP_FAILED",
              workflowId: reference.workflowId,
              elapsedMs: Date.now() - lookupStartedAt,
              status: "ERROR",
            }),
          );
          return json(502, { error: "RECORDING_LOOKUP_FAILED" });
        }
      }

      const workflowId = dependencies.createWorkflowId(now);
      const workflowStartedAt = now.toISOString();
      console.log(JSON.stringify({ event: "PIN_OK", workflowId }));
      const result = await dependencies.runQualification(runtimeSecret, workflowId, now);
      return json(200, {
        ...result,
        ...(isRecordingConfigured()
          ? {
              recordingLookup: {
                workflowId,
                startedAt: workflowStartedAt,
              },
            }
          : {}),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "QUALIFICATION_CALLER_ERROR",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return json(502, { error: "LIVE_QUALIFICATION_FAILED" });
    }
  };
}

export const handler = createHandler();
