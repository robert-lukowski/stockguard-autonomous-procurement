import type { SupportedCallLocale } from "../../server/calle";
import {
  JudgeModeBackendClient,
  JudgeModeBackendUnavailableError,
  type JudgeRunStatus,
  type JudgeSession,
} from "../../server/judge";

export type LiveJudgePhase =
  | "LOCKED"
  | "IDLE"
  | "AUTHORIZING"
  | "AUTHORIZED"
  | "CALLING"
  | "TERMINAL"
  | "ERROR";

export type LiveJudgeState = {
  phase: LiveJudgePhase;
  session: JudgeSession | null;
  status: JudgeRunStatus | null;
  error: string | null;
  /** True once polling stopped without reaching a terminal state. */
  timedOut: boolean;
};

/**
 * Bounded polling policy.
 *
 * Provisional. This is our own conservative choice for a demo, not a cadence
 * recommended by any provider, and it should be re-qualified against real
 * CALL-E runtime behavior before any live use.
 */
export const livePollPolicy = {
  intervalMs: 2_000,
  timeoutMs: 120_000,
};

export const initialLiveJudgeState: LiveJudgeState = {
  phase: "LOCKED",
  session: null,
  status: null,
  error: null,
  timedOut: false,
};

function messageFor(error: unknown): string {
  if (error instanceof JudgeModeBackendUnavailableError) {
    return "Live Judge Mode is not configured in this build.";
  }
  if (error instanceof Error) {
    // Surface the backend's own error code where it mapped one onto a status.
    if (/\b401\b/.test(error.message)) {
      return "That access code was not accepted, or the session is no longer valid.";
    }
    if (/\b409\b/.test(error.message)) {
      return "This session has already used its single call.";
    }
    if (/\b429\b/.test(error.message)) {
      return "Too many authorization attempts. Try again in a few minutes.";
    }
    if (/\b503\b/.test(error.message)) {
      return "Live calling is currently disabled by the operator kill switch or call budget.";
    }
    return error.message;
  }
  return "The request could not be completed.";
}

export type LiveJudgeDeps = {
  client: JudgeModeBackendClient;
  /** Injected so tests never wait on real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: { aborted: boolean };
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Authorizes a judge session.
 *
 * The access code is passed straight through and never stored here. When no
 * backend is configured the client throws before any network access, so the
 * code cannot leave the page.
 */
export async function authorizeJudgeSession(
  deps: LiveJudgeDeps,
  accessCode: string,
): Promise<JudgeSession> {
  return deps.client.createSession({ accessCode });
}

/**
 * Starts the one permitted call and polls until a terminal state, the timeout,
 * or cancellation.
 *
 * The runId comes from the session the backend minted; the browser never
 * supplies one. `onUpdate` fires for each observed status so the UI can show
 * progress without a second source of truth.
 */
export async function runLiveManagerCall(
  deps: LiveJudgeDeps,
  session: JudgeSession,
  input: { phoneE164: string; locale: SupportedCallLocale },
  onUpdate: (status: JudgeRunStatus) => void,
): Promise<{ status: JudgeRunStatus | null; timedOut: boolean }> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const cancelled = () => deps.signal?.aborted === true;

  await deps.client.startManagerCall(session, {
    runId: session.runId,
    phoneE164: input.phoneE164,
    locale: input.locale,
    explicitConsent: true,
    idempotencyKey: `${session.sessionId}:${session.runId}:manager:1`,
  });
  if (cancelled()) return { status: null, timedOut: false };

  const deadline = now() + livePollPolicy.timeoutMs;
  while (now() < deadline) {
    if (cancelled()) return { status: null, timedOut: false };
    const status = await deps.client.getRunStatus(session, session.runId);
    if (cancelled()) return { status: null, timedOut: false };
    onUpdate(status);
    if (status.terminal) return { status, timedOut: false };
    await sleep(livePollPolicy.intervalMs);
  }
  return { status: null, timedOut: true };
}

export { messageFor as liveJudgeErrorMessage };
