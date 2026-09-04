import type { VoiceSessionRefusal } from "../../server/webrtc";
import type { ChimeJoinGrant } from "./chimeVoiceClient";

/**
 * Browser client for the protected voice-session endpoint.
 *
 * The browser holds no AWS credential and cannot reach Amazon Connect. It asks
 * an authenticated backend endpoint, which returns a projected grant or a
 * refusal. Everything security-relevant — identity, rate limiting, single use,
 * expiry — is decided server-side; this client only renders the answer.
 *
 * Deliberately absent, and each absence is a property:
 *   - no AWS SDK, no region, no role, no credential;
 *   - no `judgeId` in the request body. The endpoint reads identity from the
 *     authenticated session, so a caller cannot name their own judge id and
 *     reset their own rate limit.
 */

export type VoiceSessionState =
  | { status: "unavailable"; message: string }
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready"; grant: ChimeJoinGrant; expiresAt: string }
  | { status: "refused"; reason: VoiceSessionRefusal | "UNKNOWN"; message: string }
  | { status: "error"; message: string };

/** Exactly the fields the portal reads back. Anything else is ignored. */
const refusalMessages: Record<VoiceSessionRefusal, string> = {
  DISABLED: "Browser voice is disabled in this deployment.",
  IDENTITY_MISSING: "You are not signed in, so no voice session can be started.",
  SESSION_EXPIRED: "This procurement session has expired. Start a new one.",
  RATE_LIMITED: "You have started too many voice sessions recently. Try again later.",
  GRANT_ALREADY_ISSUED: "A voice session is already open for this mission.",
  UPSTREAM_UNAVAILABLE: "The voice service did not answer. Nothing was started.",
  UPSTREAM_MALFORMED: "The voice service returned an unexpected response.",
};

/**
 * Reads a response without trusting its shape.
 *
 * The endpoint is ours, but a proxy, an error page or a future change can put
 * anything on the wire. An unrecognized body becomes a refusal, never a
 * half-populated "ready" state the portal would then try to join with.
 */
export function readVoiceSessionResponse(body: unknown): VoiceSessionState {
  if (typeof body !== "object" || body === null) {
    return { status: "error", message: "The voice service returned an unreadable response." };
  }
  const response = body as Record<string, unknown>;

  if (response.status === "REFUSED") {
    const reason = response.reason;
    const known = typeof reason === "string" && reason in refusalMessages;
    return {
      status: "refused",
      reason: known ? (reason as VoiceSessionRefusal) : "UNKNOWN",
      message: known
        ? refusalMessages[reason as VoiceSessionRefusal]
        : "The voice service refused the request.",
    };
  }

  if (response.status !== "STARTED") {
    return { status: "error", message: "The voice service returned an unexpected status." };
  }

  const grant = response.grant;
  if (typeof grant !== "object" || grant === null) {
    return { status: "error", message: "The voice service returned no join information." };
  }
  const typed = grant as Record<string, unknown>;
  const join = typed.joinInformation;
  if (typeof join !== "object" || join === null || typeof typed.expiresAt !== "string") {
    return { status: "error", message: "The voice service returned incomplete join information." };
  }

  /*
   * Every field the Chime SDK needs is required. A partially-populated grant
   * would fail deep inside the SDK with an opaque error, so it is rejected
   * here where the message can still say something useful.
   */
  const fields = join as Record<string, unknown>;
  const required = [
    "meetingId",
    "mediaRegion",
    "attendeeId",
    "attendeeJoinToken",
    "audioHostUrl",
    "signalingUrl",
    "turnControlUrl",
  ] as const;
  if (required.some((field) => typeof fields[field] !== "string" || fields[field] === "")) {
    return { status: "error", message: "The voice service returned incomplete join information." };
  }

  return {
    status: "ready",
    expiresAt: typed.expiresAt,
    grant: Object.fromEntries(
      required.map((field) => [field, fields[field] as string]),
    ) as unknown as ChimeJoinGrant,
  };
}

export async function startVoiceSession(
  endpoint: string,
  sessionId: string,
  missionId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<VoiceSessionState> {
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Identity comes from the authenticated session, never from this body.
      body: JSON.stringify({ sessionId, missionId }),
      credentials: "include",
    });
  } catch {
    return { status: "error", message: "The voice service could not be reached." };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "refused",
      reason: "IDENTITY_MISSING",
      message: refusalMessages.IDENTITY_MISSING,
    };
  }
  if (response.status === 429) {
    return { status: "refused", reason: "RATE_LIMITED", message: refusalMessages.RATE_LIMITED };
  }

  try {
    return readVoiceSessionResponse(await response.json());
  } catch {
    return { status: "error", message: "The voice service returned an unreadable response." };
  }
}
