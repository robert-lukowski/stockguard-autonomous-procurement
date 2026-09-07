import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const RECORDING_CLOCK_SKEW_MS = 10_000;
export const RECORDING_LOOKUP_MAX_AGE_MS = 15 * 60_000;
export const MIN_RECORDING_URL_TTL_SECONDS = 120;
export const MAX_RECORDING_URL_TTL_SECONDS = 300;

export type RecordingLookupReference = {
  workflowId: string;
  startedAt: string;
};

export type RecordingConfiguration = {
  bucket: string;
  prefix: string;
  urlTtlSeconds: number;
};

export type ReadyRecording = {
  status: "READY";
  audioUrl: string;
  contentType: "audio/wav";
  recordedAt: string;
  candidateCount: number;
};

export type ProcessingRecording = {
  status: "PROCESSING";
  candidateCount: number;
};

export class InvalidRecordingLookupError extends Error {
  constructor() {
    super("Invalid recording lookup request");
    this.name = "InvalidRecordingLookupError";
  }
}

export function parseRecordingLookupReference(
  query: Record<string, string | undefined> | undefined,
  now = new Date(),
): RecordingLookupReference {
  const workflowId = query?.recordingWorkflowId?.trim() ?? "";
  const startedAt = query?.startedAt?.trim() ?? "";
  const startedAtMs = Date.parse(startedAt);
  const ageMs = now.getTime() - startedAtMs;

  if (
    !/^live-en-\d{13}-[0-9a-f]{8}$/.test(workflowId) ||
    !Number.isFinite(startedAtMs) ||
    ageMs < -RECORDING_CLOCK_SKEW_MS ||
    ageMs > RECORDING_LOOKUP_MAX_AGE_MS
  ) {
    throw new InvalidRecordingLookupError();
  }

  return { workflowId, startedAt: new Date(startedAtMs).toISOString() };
}

export function recordingConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RecordingConfiguration | null {
  if (environment.RECORDING_ENABLED !== "true") return null;

  const bucket = environment.RECORDING_BUCKET?.trim() ?? "";
  const prefix = (environment.RECORDING_PREFIX?.trim() ?? "").replace(/^\/+|\/+$/g, "");
  const urlTtlSeconds = Number.parseInt(environment.RECORDING_URL_TTL_SECONDS ?? "", 10);

  if (
    !bucket ||
    !prefix ||
    !Number.isInteger(urlTtlSeconds) ||
    urlTtlSeconds < MIN_RECORDING_URL_TTL_SECONDS ||
    urlTtlSeconds > MAX_RECORDING_URL_TTL_SECONDS
  ) {
    throw new Error("Recording lookup configuration is invalid");
  }

  return { bucket, prefix, urlTtlSeconds };
}

export function isRecordingConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return recordingConfigurationFromEnvironment(environment) !== null;
  } catch {
    return false;
  }
}

type RecordingLookupDependencies = {
  now?: () => Date;
  s3Client?: S3Client;
  presign?: typeof getSignedUrl;
};

function isRecentWav(
  object: _Object,
  objectPrefix: string,
  earliestMs: number,
  latestMs: number,
): object is _Object & { Key: string; LastModified: Date } {
  if (!object.Key || !object.LastModified) return false;
  const modifiedMs = object.LastModified.getTime();
  return (
    object.Key.startsWith(objectPrefix) &&
    /\.wav$/i.test(object.Key) &&
    modifiedMs >= earliestMs &&
    modifiedMs <= latestMs
  );
}

export async function findRecentRecording(
  reference: RecordingLookupReference,
  configuration: RecordingConfiguration,
  dependencies: RecordingLookupDependencies = {},
): Promise<ProcessingRecording | ReadyRecording> {
  const now = dependencies.now?.() ?? new Date();
  const startedAtMs = Date.parse(reference.startedAt);
  const earliestMs = startedAtMs - RECORDING_CLOCK_SKEW_MS;
  const latestMs = now.getTime();
  const objectPrefix = `${configuration.prefix}/`;
  const s3Client = dependencies.s3Client ?? new S3Client({});

  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: configuration.bucket,
      Prefix: objectPrefix,
      MaxKeys: 1_000,
    }),
  );
  const candidates = (response.Contents ?? [])
    .filter((object) => isRecentWav(object, objectPrefix, earliestMs, latestMs))
    .sort((left, right) => right.LastModified.getTime() - left.LastModified.getTime());

  const selected = candidates[0];
  if (!selected) {
    return { status: "PROCESSING", candidateCount: 0 };
  }

  const presign = dependencies.presign ?? getSignedUrl;
  const audioUrl = await presign(
    s3Client,
    new GetObjectCommand({
      Bucket: configuration.bucket,
      Key: selected.Key,
      ResponseContentType: "audio/wav",
      ResponseContentDisposition: "inline",
    }),
    { expiresIn: configuration.urlTtlSeconds },
  );

  return {
    status: "READY",
    audioUrl,
    contentType: "audio/wav",
    recordedAt: selected.LastModified.toISOString(),
    candidateCount: candidates.length,
  };
}
