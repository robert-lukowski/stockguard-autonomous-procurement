import {
  VoiceSessionDisabledError,
  type VoiceSessionGrant,
  type VoiceSessionProvider,
  type VoiceSessionRequest,
} from "./types";

/**
 * WebRTC Judge Mode is OFF unless something explicitly turns it on.
 *
 * The flag is read as an exact `"true"`. Anything else — unset, empty,
 * "TRUE", "1", "yes" — leaves it disabled, so a mistyped environment variable
 * cannot accidentally arm a voice path that places a real Amazon Connect
 * contact.
 */
export function isWebRtcJudgeModeEnabled(
  raw: string | undefined | null,
): boolean {
  return raw === "true";
}

/**
 * The only provider this repository ships.
 *
 * Every call fails closed. Enabling WebRTC Judge Mode means writing a real
 * provider against `VoiceSessionProvider` AND deploying the protected backend
 * endpoint described in `docs/adr-0001-webrtc-judge-portal.md` — it is
 * deliberately not a matter of flipping this flag.
 */
export class DisabledVoiceSessionProvider implements VoiceSessionProvider {
  readonly enabled = false;

  async createSession(request: VoiceSessionRequest): Promise<VoiceSessionGrant> {
    // Naming the refused session makes the disabled path debuggable without
    // logging anything about the judge.
    throw new VoiceSessionDisabledError(
      `WebRTC Judge Mode is disabled in this build; refused session ${request.sessionId}`,
    );
  }
}

/**
 * Server-side controls a real provider MUST satisfy before it is wired up.
 *
 * Stated as data so a future implementation has an explicit contract to meet
 * and a test to meet it against, rather than a paragraph in a document.
 */
export const webRtcSessionControls = {
  /** One grant serves one contact and is consumed on use. */
  singleUse: true,
  /** Short enough that a leaked grant is worthless quickly. */
  maxGrantLifetimeSeconds: 120,
  /** Per-identity ceiling enforced server-side, in a durable store. */
  maxSessionsPerJudgePerHour: 3,
  /** Never sent to the browser under any circumstances. */
  browserReceivesAwsCredentials: false,
  /** The endpoint is authenticated; there is no public unauthenticated path. */
  publicUnauthenticatedEndpoint: false,
} as const;
