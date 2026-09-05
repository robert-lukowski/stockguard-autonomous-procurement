import type { VoiceSessionGrant } from "./types";

/**
 * The Amazon Connect `StartWebRTCContact` boundary.
 *
 * Nothing in this repository calls Connect. The port exists so the shape is
 * fixed, the parsing is written and tested, and a deployed composition root can
 * supply the SDK call without any of the validation below moving.
 *
 * The upstream response arrives as `unknown` deliberately. An AWS SDK response
 * is a large object carrying request metadata, and passing it through to the
 * browser — or even into our own grant type — would leak far more than the
 * browser needs. Everything the browser receives is projected field by field.
 */

export type StartWebRtcContactInput = {
  /** Correlates the contact with the procurement session. Never a credential. */
  sessionId: string;
  missionId: string;
  /** Opaque backend-issued identity. Never an AWS principal. */
  judgeId: string;
};

export interface ConnectWebRtcContactPort {
  readonly enabled: boolean;
  startWebRtcContact(input: StartWebRtcContactInput): Promise<unknown>;
}

export class ConnectContactDisabledError extends Error {
  readonly code = "CONNECT_CONTACT_DISABLED";

  constructor(sessionId: string) {
    super(`Amazon Connect WebRTC contacts are disabled; refused session ${sessionId}`);
    this.name = "ConnectContactDisabledError";
  }
}

export class MalformedConnectResponseError extends Error {
  readonly code = "CONNECT_RESPONSE_MALFORMED";

  constructor(public readonly field: string) {
    super(`Amazon Connect WebRTC response is missing or malformed: ${field}`);
    this.name = "MalformedConnectResponseError";
  }
}

/**
 * The only port shipped.
 *
 * Enabling live WebRTC means writing a real implementation AND deploying the
 * protected backend endpoint. It is deliberately not a matter of flipping a
 * flag on this class.
 */
export class DisabledConnectWebRtcContactPort implements ConnectWebRtcContactPort {
  readonly enabled = false;

  async startWebRtcContact(input: StartWebRtcContactInput): Promise<unknown> {
    throw new ConnectContactDisabledError(input.sessionId);
  }
}

export type ParsedConnectContact = {
  contactId: string;
  participantId: string;
  participantToken: string;
  meetingId: string;
  attendeeId: string;
  attendeeJoinToken: string;
  mediaRegion: string;
  /*
   * MediaPlacement endpoints. The Chime SDK cannot join without them, and they
   * are URLs rather than credentials: possessing one grants nothing without the
   * attendee join token. Only the three the audio path uses are projected;
   * ScreenDataUrl, EventIngestionUrl and the rest are dropped.
   */
  audioHostUrl: string;
  signalingUrl: string;
  turnControlUrl: string;
};

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedConnectResponseError(field);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MalformedConnectResponseError(field);
  }
  return value;
}

/**
 * Projects a `StartWebRTCContact` response onto exactly the fields we use.
 *
 * Fail-closed by construction: every field is required, and anything the
 * response carries beyond these seven is dropped rather than forwarded. A
 * partial or reshaped response raises `MalformedConnectResponseError` instead
 * of producing a grant with undefined fields the browser would then try to
 * join with.
 */
export function parseConnectWebRtcResponse(raw: unknown): ParsedConnectContact {
  const response = requireObject(raw, "response");
  const connectionData = requireObject(response.ConnectionData, "ConnectionData");
  const attendee = requireObject(connectionData.Attendee, "ConnectionData.Attendee");
  const meeting = requireObject(connectionData.Meeting, "ConnectionData.Meeting");

  const placement = requireObject(
    meeting.MediaPlacement,
    "ConnectionData.Meeting.MediaPlacement",
  );

  return {
    contactId: requireString(response.ContactId, "ContactId"),
    participantId: requireString(response.ParticipantId, "ParticipantId"),
    participantToken: requireString(response.ParticipantToken, "ParticipantToken"),
    meetingId: requireString(meeting.MeetingId, "ConnectionData.Meeting.MeetingId"),
    attendeeId: requireString(attendee.AttendeeId, "ConnectionData.Attendee.AttendeeId"),
    attendeeJoinToken: requireString(
      attendee.JoinToken,
      "ConnectionData.Attendee.JoinToken",
    ),
    mediaRegion: requireString(
      meeting.MediaRegion,
      "ConnectionData.Meeting.MediaRegion",
    ),
    audioHostUrl: requireString(
      placement.AudioHostUrl,
      "ConnectionData.Meeting.MediaPlacement.AudioHostUrl",
    ),
    signalingUrl: requireString(
      placement.SignalingUrl,
      "ConnectionData.Meeting.MediaPlacement.SignalingUrl",
    ),
    turnControlUrl: requireString(
      placement.TurnControlUrl,
      "ConnectionData.Meeting.MediaPlacement.TurnControlUrl",
    ),
  };
}

/**
 * Builds the grant the browser receives.
 *
 * `contactId` and `participantId` are deliberately NOT included: the browser
 * joins with the Chime attendee material and the participant token, and a
 * contact id is a server-side correlation handle it has no use for.
 */
export function toVoiceSessionGrant(
  sessionId: string,
  contact: ParsedConnectContact,
  expiresAt: string,
): VoiceSessionGrant {
  return {
    sessionId,
    participantToken: contact.participantToken,
    joinInformation: {
      meetingId: contact.meetingId,
      attendeeId: contact.attendeeId,
      attendeeJoinToken: contact.attendeeJoinToken,
      mediaRegion: contact.mediaRegion,
      audioHostUrl: contact.audioHostUrl,
      signalingUrl: contact.signalingUrl,
      turnControlUrl: contact.turnControlUrl,
    },
    expiresAt,
    singleUse: true,
  };
}
