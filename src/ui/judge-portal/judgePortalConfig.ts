import { isWebRtcJudgeModeEnabled } from "../../server/webrtc";

/**
 * Judge Portal build configuration.
 *
 * The voice channel is a scaffold only. Nothing in this build opens a
 * microphone, contacts Amazon Connect, or holds an AWS credential: enabling
 * the flag reveals the seam and its status, and the portal keeps running the
 * procurement flow over the local text channel either way.
 */
export type JudgePortalConfig = {
  webRtcEnabled: boolean;
  /** Why voice is unavailable, in words a judge can act on. */
  voiceStatus: string;
};

export function resolveJudgePortalConfig(
  rawFlag: string | undefined = import.meta.env?.VITE_WEBRTC_JUDGE_MODE,
  rawSessionEndpoint: string | undefined = import.meta.env?.VITE_WEBRTC_SESSION_URL,
): JudgePortalConfig {
  const flagged = isWebRtcJudgeModeEnabled(rawFlag);
  const endpointConfigured =
    typeof rawSessionEndpoint === "string" && rawSessionEndpoint.trim().length > 0;

  if (!flagged) {
    return {
      webRtcEnabled: false,
      voiceStatus:
        "Browser voice is off in this build. The mission runs over the local text channel, which exercises the same procurement core.",
    };
  }
  if (!endpointConfigured) {
    /*
     * Flag on, backend absent. Fail closed rather than letting the portal try
     * to reach Amazon Connect from the browser: a WebRTC contact may only ever
     * be started by the protected backend endpoint.
     */
    return {
      webRtcEnabled: false,
      voiceStatus:
        "Browser voice is enabled but no protected session endpoint is configured, so no contact can be started.",
    };
  }
  return {
    webRtcEnabled: true,
    voiceStatus:
      "Browser voice is enabled. A session is requested from the protected backend endpoint; the browser never receives AWS credentials.",
  };
}
