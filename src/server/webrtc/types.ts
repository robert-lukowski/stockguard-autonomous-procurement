/**
 * The seam for a future Amazon Connect WebRTC Judge Mode.
 *
 * Target runtime, for orientation only — none of it is deployed by this
 * repository today:
 *
 *   Judge Portal
 *     -> protected backend session endpoint (authenticated, rate limited)
 *     -> Amazon Connect StartWebRTCContact
 *     -> browser joins through the Amazon Chime SDK
 *     -> Connect flow
 *     -> Lex / Lambda orchestrator
 *     -> the controlled procurement tools in `src/server/procurement`
 *
 * The one rule this file exists to encode: THE BROWSER NEVER RECEIVES AWS
 * CREDENTIALS. `VoiceSessionGrant` carries only the short-lived, single-use
 * join material Connect hands back for one contact. There is no field for an
 * access key, a session token, a role ARN or an instance id, and
 * `assertNoAwsCredentialMaterial` fails closed if one is ever smuggled in.
 */

export type VoiceSessionRequest = {
  sessionId: string;
  missionId: string;
  /** Opaque, backend-issued. Never an AWS principal. */
  requestedBy: string;
};

export type VoiceSessionGrant = {
  sessionId: string;
  /** Connect's participant token for ONE contact. Not an AWS credential. */
  participantToken: string;
  /** Chime SDK meeting/attendee join material, passed through verbatim. */
  joinInformation: Record<string, string>;
  expiresAt: string;
  singleUse: true;
};

export class VoiceSessionDisabledError extends Error {
  readonly code = "WEBRTC_JUDGE_MODE_DISABLED";

  constructor(message = "WebRTC Judge Mode is disabled in this build") {
    super(message);
    this.name = "VoiceSessionDisabledError";
  }
}

export class VoiceSessionCredentialLeakError extends Error {
  readonly code = "WEBRTC_CREDENTIAL_LEAK";

  constructor(field: string) {
    super(`Voice session grant must not carry AWS credential material (${field})`);
    this.name = "VoiceSessionCredentialLeakError";
  }
}

export interface VoiceSessionProvider {
  readonly enabled: boolean;
  createSession(request: VoiceSessionRequest): Promise<VoiceSessionGrant>;
}

const forbiddenKeyPatterns = [
  /accesskey/i,
  /secret/i,
  /sessiontoken/i,
  /^credentials?$/i,
  /assumedrole/i,
  /rolearn/i,
  /^arn$/i,
];

const forbiddenValuePatterns = [
  /\bASIA[0-9A-Z]{16}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\barn:aws:iam::/i,
  /\barn:aws:sts::/i,
];

/**
 * Fails closed if a grant carries anything credential-shaped.
 *
 * Checked on the way OUT of the backend rather than trusted at design time,
 * because the field that leaks a credential is usually one nobody reviewed.
 */
export function assertNoAwsCredentialMaterial(grant: VoiceSessionGrant): void {
  const inspect = (key: string, value: unknown, path: string): void => {
    for (const pattern of forbiddenKeyPatterns) {
      if (pattern.test(key)) throw new VoiceSessionCredentialLeakError(path);
    }
    if (typeof value === "string") {
      for (const pattern of forbiddenValuePatterns) {
        if (pattern.test(value)) throw new VoiceSessionCredentialLeakError(path);
      }
    }
  };

  for (const [key, value] of Object.entries(grant)) {
    if (key === "participantToken") continue;
    inspect(key, value, key);
    if (key === "joinInformation" && value && typeof value === "object") {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        inspect(innerKey, innerValue, `joinInformation.${innerKey}`);
      }
    }
  }
}
