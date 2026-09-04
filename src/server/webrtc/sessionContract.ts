import {
  ConnectContactDisabledError,
  MalformedConnectResponseError,
  parseConnectWebRtcResponse,
  toVoiceSessionGrant,
  type ConnectWebRtcContactPort,
} from "./connectContact";
import { webRtcSessionControls } from "./config";
import { assertNoAwsCredentialMaterial, type VoiceSessionGrant } from "./types";
import type { VoiceRateLimiter, VoiceSessionStore } from "./voiceSessionStore";

/**
 * The protected backend contract for starting a WebRTC voice session.
 *
 * This is the ONLY way a browser may reach Amazon Connect, and it is the reason
 * the browser never needs an AWS credential: the credential stays in the
 * backend's execution role, and what crosses to the browser is a projected
 * grant with a short expiry.
 *
 * The endpoint that exposes this service must be authenticated. `judgeId` comes
 * from that authenticated identity and must never be read from a request body;
 * a caller who could name their own judge id could also reset their own rate
 * limit.
 *
 * Every failure mode below is fail-closed: it returns a status and no grant.
 * There is no path that returns a partially-populated grant.
 */

export type VoiceSessionRefusal =
  | "DISABLED"
  | "IDENTITY_MISSING"
  | "SESSION_EXPIRED"
  | "RATE_LIMITED"
  | "GRANT_ALREADY_ISSUED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_MALFORMED";

export type StartVoiceSessionCommand = {
  /** From the authenticated principal. NEVER from the request body. */
  judgeId: string;
  sessionId: string;
  missionId: string;
  /** Expiry of the procurement session this voice contact belongs to. */
  procurementSessionExpiresAt: string;
  now: Date;
};

export type StartVoiceSessionResult =
  | { status: "STARTED"; grant: VoiceSessionGrant }
  | { status: "REFUSED"; reason: VoiceSessionRefusal; message: string };

export type VoiceSessionServiceConfig = {
  enabled: boolean;
  contacts: ConnectWebRtcContactPort;
  store: VoiceSessionStore;
  rateLimiter: VoiceRateLimiter;
  grantLifetimeSeconds?: number;
};

function refuse(
  reason: VoiceSessionRefusal,
  message: string,
): StartVoiceSessionResult {
  return { status: "REFUSED", reason, message };
}

export class VoiceSessionService {
  private readonly grantLifetimeSeconds: number;

  constructor(private readonly config: VoiceSessionServiceConfig) {
    const requested =
      config.grantLifetimeSeconds ?? webRtcSessionControls.maxGrantLifetimeSeconds;
    if (!Number.isInteger(requested) || requested <= 0) {
      throw new Error("WebRTC grant lifetime must be a positive number of seconds");
    }
    /*
     * The declared maximum is a ceiling, not a default. A configuration that
     * asks for a longer-lived grant is clamped rather than honoured, so a
     * misconfiguration cannot quietly widen the window in which a leaked grant
     * is useful.
     */
    this.grantLifetimeSeconds = Math.min(
      requested,
      webRtcSessionControls.maxGrantLifetimeSeconds,
    );
  }

  async start(command: StartVoiceSessionCommand): Promise<StartVoiceSessionResult> {
    if (!this.config.enabled || !this.config.contacts.enabled) {
      return refuse(
        "DISABLED",
        "WebRTC Judge Mode is disabled in this deployment.",
      );
    }

    if (typeof command.judgeId !== "string" || command.judgeId.trim().length === 0) {
      /*
       * No authenticated identity means no rate limit can be attributed, so
       * proceeding would create an unmetered path to a billable contact.
       */
      return refuse(
        "IDENTITY_MISSING",
        "No authenticated judge identity was supplied.",
      );
    }

    if (Date.parse(command.procurementSessionExpiresAt) <= command.now.getTime()) {
      return refuse(
        "SESSION_EXPIRED",
        "The procurement session has expired, so no voice contact can be started.",
      );
    }

    // Checked BEFORE the upstream call, so a throttled caller costs nothing.
    if (!(await this.config.rateLimiter.allow(command.judgeId, command.now))) {
      return refuse(
        "RATE_LIMITED",
        "This judge has started too many voice sessions recently.",
      );
    }

    const expiresAt = new Date(
      command.now.getTime() + this.grantLifetimeSeconds * 1000,
    ).toISOString();

    let raw: unknown;
    try {
      raw = await this.config.contacts.startWebRtcContact({
        sessionId: command.sessionId,
        missionId: command.missionId,
        judgeId: command.judgeId,
      });
    } catch (error) {
      if (error instanceof ConnectContactDisabledError) {
        return refuse("DISABLED", "WebRTC Judge Mode is disabled in this deployment.");
      }
      return refuse(
        "UPSTREAM_UNAVAILABLE",
        "Amazon Connect did not start a contact. No voice session was created.",
      );
    }

    let grant: VoiceSessionGrant;
    try {
      const contact = parseConnectWebRtcResponse(raw);
      grant = toVoiceSessionGrant(command.sessionId, contact, expiresAt);
      /*
       * Belt and braces. The projection above already allowlists fields, so
       * this can only fire if a future edit widens it — which is exactly when
       * an assertion is worth having.
       */
      assertNoAwsCredentialMaterial(grant);

      const claim = await this.config.store.claimGrant({
        sessionId: command.sessionId,
        judgeId: command.judgeId,
        contactId: contact.contactId,
        issuedAt: command.now.toISOString(),
        expiresAt,
        consumedAt: null,
      });
      if (claim.kind === "ALREADY_ISSUED") {
        /*
         * A grant already exists for this procurement session. Returning the
         * new one would mean two live contacts for one session, so the new
         * contact is abandoned and the caller is refused. Deliberately does NOT
         * return the stored grant: re-issuing join material on demand would
         * turn a single-use grant into a replayable one.
         */
        return refuse(
          "GRANT_ALREADY_ISSUED",
          "A voice session has already been started for this procurement session.",
        );
      }
    } catch (error) {
      if (error instanceof MalformedConnectResponseError) {
        return refuse(
          "UPSTREAM_MALFORMED",
          "Amazon Connect returned a response this backend does not recognise.",
        );
      }
      throw error;
    }

    return { status: "STARTED", grant };
  }

  /** Marks a grant used. A consumed grant is never re-issued. */
  async consume(sessionId: string, now: Date): Promise<void> {
    await this.config.store.markConsumed(sessionId, now.toISOString());
  }
}
