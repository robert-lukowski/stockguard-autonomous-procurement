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
  /** The protected backend endpoint. Null whenever voice is unavailable. */
  sessionEndpoint: string | null;
  /** Where the access code is exchanged for a session token. */
  loginEndpoint: string | null;
  /** Why voice is unavailable, in words a judge can act on. */
  voiceStatus: string;
};

export function resolveJudgePortalConfig(
  rawFlag: string | undefined = import.meta.env?.VITE_WEBRTC_JUDGE_MODE,
  rawSessionEndpoint: string | undefined = import.meta.env?.VITE_WEBRTC_SESSION_URL,
  rawLoginEndpoint: string | undefined = import.meta.env?.VITE_JUDGE_LOGIN_URL,
): JudgePortalConfig {
  const flagged = isWebRtcJudgeModeEnabled(rawFlag);
  const endpoint =
    typeof rawSessionEndpoint === "string" && rawSessionEndpoint.trim().length > 0
      ? rawSessionEndpoint.trim()
      : null;
  const login =
    typeof rawLoginEndpoint === "string" && rawLoginEndpoint.trim().length > 0
      ? rawLoginEndpoint.trim()
      : null;

  if (!flagged) {
    return {
      webRtcEnabled: false,
      sessionEndpoint: null,
      loginEndpoint: null,
      voiceStatus:
        "Browser voice is off in this build. The mission runs over the local text channel, which exercises the same procurement core.",
    };
  }
  if (endpoint === null || login === null) {
    /*
     * Flag on, backend absent. Fail closed rather than letting the portal try
     * to reach Amazon Connect from the browser: a WebRTC contact may only ever
     * be started by the protected backend endpoint.
     */
    /*
     * Both endpoints or neither. A voice endpoint without a sign-in endpoint
     * would leave the judge with no way to obtain a token, and the portal
     * showing a Start button that can only ever return 401.
     */
    return {
      webRtcEnabled: false,
      sessionEndpoint: null,
      loginEndpoint: null,
      voiceStatus:
        "Browser voice is enabled but the protected sign-in and session endpoints are not both configured, so no contact can be started.",
    };
  }
  return {
    webRtcEnabled: true,
    sessionEndpoint: endpoint,
    loginEndpoint: login,
    voiceStatus:
      "Enter the judge access code, then start the voice demo. The browser never receives AWS credentials.",
  };
}
