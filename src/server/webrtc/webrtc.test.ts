import { describe, expect, it } from "vitest";

import {
  assertNoAwsCredentialMaterial,
  DisabledVoiceSessionProvider,
  isWebRtcJudgeModeEnabled,
  VoiceSessionCredentialLeakError,
  VoiceSessionDisabledError,
  webRtcSessionControls,
  type VoiceSessionGrant,
} from "./index";

const grant: VoiceSessionGrant = {
  sessionId: "session-0001",
  participantToken: "connect-participant-token",
  joinInformation: { meetingId: "m-1", attendeeId: "a-1" },
  expiresAt: "2026-09-04T09:02:00.000Z",
  singleUse: true,
};

describe("WebRTC Judge Mode", () => {
  it("is disabled unless the flag is exactly \"true\"", () => {
    expect(isWebRtcJudgeModeEnabled("true")).toBe(true);
    for (const raw of [undefined, null, "", "TRUE", "True", "1", "yes", "false"]) {
      expect(isWebRtcJudgeModeEnabled(raw)).toBe(false);
    }
  });

  it("ships only a provider that fails closed", async () => {
    const provider = new DisabledVoiceSessionProvider();

    expect(provider.enabled).toBe(false);
    await expect(
      provider.createSession({ sessionId: "s", missionId: "m", requestedBy: "judge" }),
    ).rejects.toBeInstanceOf(VoiceSessionDisabledError);
  });

  it("declares the server-side controls a real provider must satisfy", () => {
    expect(webRtcSessionControls.singleUse).toBe(true);
    expect(webRtcSessionControls.browserReceivesAwsCredentials).toBe(false);
    expect(webRtcSessionControls.publicUnauthenticatedEndpoint).toBe(false);
    expect(webRtcSessionControls.maxGrantLifetimeSeconds).toBeLessThanOrEqual(300);
    expect(webRtcSessionControls.maxSessionsPerJudgePerHour).toBeGreaterThan(0);
  });

  it("accepts a grant that carries only Chime join material", () => {
    expect(() => assertNoAwsCredentialMaterial(grant)).not.toThrow();
  });

  it("rejects a grant carrying credential-shaped fields", () => {
    for (const leaked of [
      { ...grant, joinInformation: { ...grant.joinInformation, accessKeyId: "AKIA1234567890ABCDEF" } },
      { ...grant, joinInformation: { ...grant.joinInformation, sessionToken: "x" } },
      { ...grant, joinInformation: { ...grant.joinInformation, roleArn: "arn:aws:iam::1:role/x" } },
      { ...grant, joinInformation: { ...grant.joinInformation, region: "arn:aws:sts::1:assumed-role/x" } },
    ]) {
      expect(() => assertNoAwsCredentialMaterial(leaked as VoiceSessionGrant)).toThrow(
        VoiceSessionCredentialLeakError,
      );
    }
  });
});
