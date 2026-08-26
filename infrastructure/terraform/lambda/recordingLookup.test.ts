import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  findRecentRecording,
  MAX_RECORDING_URL_TTL_SECONDS,
  parseRecordingLookupReference,
  recordingConfigurationFromEnvironment,
  type RecordingConfiguration,
  type RecordingLookupReference,
} from "./recordingLookup";

const now = new Date("2026-08-25T12:05:00.000Z");
const reference: RecordingLookupReference = {
  workflowId: "live-en-1787659440000-deadbeef",
  startedAt: "2026-08-25T12:04:00.000Z",
};
const configuration: RecordingConfiguration = {
  bucket: "private-recordings",
  prefix: "connect/qualification/CallRecordings",
  urlTtlSeconds: 300,
};

function dependencies(contents: Array<{ Key?: string; LastModified?: Date }>) {
  const send = vi.fn().mockResolvedValue({ Contents: contents });
  const presign = vi.fn().mockResolvedValue("https://signed.example/audio.wav");
  return {
    send,
    presign,
    value: {
      now: () => now,
      s3Client: { send } as unknown as S3Client,
      presign,
    },
  };
}

describe("recording lookup", () => {
  it("rejects invalid or expired lookup references", () => {
    expect(() =>
      parseRecordingLookupReference(
        { recordingWorkflowId: "not-a-workflow", startedAt: reference.startedAt },
        now,
      ),
    ).toThrow("Invalid recording lookup request");
    expect(() =>
      parseRecordingLookupReference(
        {
          recordingWorkflowId: reference.workflowId,
          startedAt: "2026-08-25T11:49:59.000Z",
        },
        now,
      ),
    ).toThrow("Invalid recording lookup request");
  });

  it("accepts a recording lookup reference within the extended fifteen-minute window", () => {
    expect(
      parseRecordingLookupReference(
        {
          recordingWorkflowId: reference.workflowId,
          startedAt: "2026-08-25T11:50:01.000Z",
        },
        now,
      ),
    ).toEqual({
      workflowId: reference.workflowId,
      startedAt: "2026-08-25T11:50:01.000Z",
    });
  });

  it("treats an absent recent recording as processing", async () => {
    const mock = dependencies([]);

    await expect(findRecentRecording(reference, configuration, mock.value)).resolves.toEqual({
      status: "PROCESSING",
      candidateCount: 0,
    });
    expect(mock.presign).not.toHaveBeenCalled();
  });

  it("ignores recordings older than the clock-skew window", async () => {
    const mock = dependencies([
      {
        Key: "connect/qualification/CallRecordings/old.wav",
        LastModified: new Date("2026-08-25T12:03:49.999Z"),
      },
    ]);

    await expect(findRecentRecording(reference, configuration, mock.value)).resolves.toMatchObject({
      status: "PROCESSING",
    });
  });

  it("ignores non-audio objects and objects outside the configured prefix", async () => {
    const mock = dependencies([
      {
        Key: "connect/qualification/CallRecordings/contact.json",
        LastModified: new Date("2026-08-25T12:04:10.000Z"),
      },
      {
        Key: "another-prefix/recording.wav",
        LastModified: new Date("2026-08-25T12:04:20.000Z"),
      },
    ]);

    await expect(findRecentRecording(reference, configuration, mock.value)).resolves.toMatchObject({
      status: "PROCESSING",
    });
  });

  it("selects the newest recent WAV and presigns it for five minutes", async () => {
    const mock = dependencies([
      {
        Key: "connect/qualification/CallRecordings/first.wav",
        LastModified: new Date("2026-08-25T12:04:10.000Z"),
      },
      {
        Key: "connect/qualification/CallRecordings/newest.WAV",
        LastModified: new Date("2026-08-25T12:04:40.000Z"),
      },
    ]);

    await expect(findRecentRecording(reference, configuration, mock.value)).resolves.toEqual({
      status: "READY",
      audioUrl: "https://signed.example/audio.wav",
      contentType: "audio/wav",
      recordedAt: "2026-08-25T12:04:40.000Z",
      candidateCount: 2,
    });
    expect(mock.presign).toHaveBeenCalledTimes(1);
    const [, command, options] = mock.presign.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: configuration.bucket,
      Key: "connect/qualification/CallRecordings/newest.WAV",
      ResponseContentType: "audio/wav",
    });
    expect(options).toEqual({ expiresIn: MAX_RECORDING_URL_TTL_SECONDS });
  });

  it("accepts only a short configured URL TTL", () => {
    expect(
      recordingConfigurationFromEnvironment({
        RECORDING_ENABLED: "true",
        RECORDING_BUCKET: configuration.bucket,
        RECORDING_PREFIX: configuration.prefix,
        RECORDING_URL_TTL_SECONDS: "300",
      }),
    ).toEqual(configuration);
    expect(() =>
      recordingConfigurationFromEnvironment({
        RECORDING_ENABLED: "true",
        RECORDING_BUCKET: configuration.bucket,
        RECORDING_PREFIX: configuration.prefix,
        RECORDING_URL_TTL_SECONDS: "3600",
      }),
    ).toThrow("Recording lookup configuration is invalid");
  });
});
