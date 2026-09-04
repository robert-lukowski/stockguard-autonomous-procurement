import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
  type AudioVideoFacade,
} from "amazon-chime-sdk-js";

/**
 * Browser-side Amazon Chime SDK audio for the Judge Portal.
 *
 * The browser holds no AWS credential. Everything here is driven by the
 * projected grant the protected backend returned, which carries only Chime join
 * material and an expiry.
 *
 * Audio only. Video capability is negotiated by Connect, but the portal never
 * opens a camera: a procurement demo has no use for one, and not requesting it
 * means the browser never prompts for it.
 */

export type VoicePhase =
  | "idle"
  | "requesting-microphone"
  | "microphone-denied"
  | "connecting"
  | "connected"
  | "ended"
  | "failed";

export type VoiceCallState = {
  phase: VoicePhase;
  message: string;
};

/** The subset of the grant the Chime SDK actually needs to join. */
export type ChimeJoinGrant = {
  meetingId: string;
  mediaRegion: string;
  attendeeId: string;
  attendeeJoinToken: string;
  audioHostUrl: string;
  signalingUrl: string;
  turnControlUrl: string;
};

export const voiceMessages: Record<VoicePhase, string> = {
  idle: "Voice is idle.",
  "requesting-microphone": "Waiting for microphone permission...",
  "microphone-denied":
    "Microphone access was refused, so the voice demo cannot start. The mission still runs over the text channel.",
  connecting: "Connecting to the StockGuard voice agent...",
  connected: "Connected. Say what you need.",
  ended: "The voice session has ended.",
  failed: "The voice session could not be established.",
};

export function voiceState(phase: VoicePhase, message?: string): VoiceCallState {
  return { phase, message: message ?? voiceMessages[phase] };
}

/**
 * Distinguishes a refused microphone from a broken one.
 *
 * They need different words: a refusal is the judge's own choice and is
 * recoverable from the browser's permission UI, while a missing device is not
 * something re-clicking will fix.
 */
export function classifyMicrophoneError(error: unknown): VoiceCallState {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return voiceState("microphone-denied");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return voiceState(
      "failed",
      "No microphone was found, so the voice demo cannot start.",
    );
  }
  return voiceState("failed", "The microphone could not be opened.");
}

export interface VoiceCall {
  stop(): Promise<void>;
}

export type StartVoiceCallOptions = {
  grant: ChimeJoinGrant;
  onState: (state: VoiceCallState) => void;
  /** Injected in tests; the browser supplies the real element. */
  audioElement: HTMLAudioElement;
};

/**
 * The Chime `MeetingSessionConfiguration` expects AWS-shaped join material.
 *
 * Built here from our flat grant so the projection stays one-way: the backend
 * decides what the browser learns, and this file adapts it rather than asking
 * for more.
 */
export function meetingConfiguration(grant: ChimeJoinGrant): MeetingSessionConfiguration {
  return new MeetingSessionConfiguration(
    {
      MeetingId: grant.meetingId,
      MediaRegion: grant.mediaRegion,
      MediaPlacement: {
        AudioHostUrl: grant.audioHostUrl,
        SignalingUrl: grant.signalingUrl,
        TurnControlUrl: grant.turnControlUrl,
      },
    },
    {
      AttendeeId: grant.attendeeId,
      JoinToken: grant.attendeeJoinToken,
    },
  );
}

/**
 * Joins the meeting, binding the microphone and the remote audio.
 *
 * Permission is requested before anything else, so a judge who declines never
 * causes a Chime session to be created — and therefore never leaves a
 * half-joined attendee behind.
 */
export async function startVoiceCall(
  options: StartVoiceCallOptions,
): Promise<VoiceCall | null> {
  const { grant, onState, audioElement } = options;

  onState(voiceState("requesting-microphone"));
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // The device controller opens its own stream; this one only proves consent.
    for (const track of stream.getTracks()) track.stop();
  } catch (error) {
    onState(classifyMicrophoneError(error));
    return null;
  }

  onState(voiceState("connecting"));

  const logger = new ConsoleLogger("StockGuardVoice", LogLevel.WARN);
  const deviceController = new DefaultDeviceController(logger);
  const session = new DefaultMeetingSession(
    meetingConfiguration(grant),
    logger,
    deviceController,
  );
  const audioVideo: AudioVideoFacade = session.audioVideo;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      audioVideo.stop();
      await deviceController.destroy();
    } finally {
      onState(voiceState("ended"));
    }
  };

  audioVideo.addObserver({
    audioVideoDidStart: () => onState(voiceState("connected")),
    audioVideoDidStop: () => {
      if (!stopped) {
        stopped = true;
        onState(voiceState("ended"));
      }
    },
  });

  try {
    const devices = await audioVideo.listAudioInputDevices();
    if (devices.length === 0) {
      onState(voiceState("failed", "No microphone was found, so the voice demo cannot start."));
      await deviceController.destroy();
      return null;
    }
    await audioVideo.startAudioInput(devices[0].deviceId);
    await audioVideo.bindAudioElement(audioElement);
    audioVideo.start();
  } catch {
    onState(voiceState("failed"));
    await deviceController.destroy();
    return null;
  }

  return { stop };
}
