export const RECORDING_POLL_INTERVAL_MS = 3_000;
export const RECORDING_POLL_LIMIT = 100;

export type RecordingLookupReference = {
  workflowId: string;
  startedAt: string;
};

export type LiveRecordingState =
  | { status: "idle" }
  | { status: "processing" }
  | { status: "ready"; audioUrl: string; contentType?: string; recordedAt?: string }
  | { status: "disabled" }
  | { status: "unavailable" }
  | { status: "error" };

type PollRecordingOptions = {
  backendUrl: string;
  judgePin: string;
  reference: RecordingLookupReference;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  intervalMs?: number;
};

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Recording lookup aborted", "AbortError"));
      return;
    }

    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Recording lookup aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function readyState(body: Record<string, unknown>): LiveRecordingState | null {
  if (body.status !== "READY" || typeof body.audioUrl !== "string") return null;
  try {
    const audioUrl = new URL(body.audioUrl);
    if (audioUrl.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return {
    status: "ready",
    audioUrl: body.audioUrl,
    ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
    ...(typeof body.recordedAt === "string" ? { recordedAt: body.recordedAt } : {}),
  };
}

export async function pollForRecording({
  backendUrl,
  judgePin,
  reference,
  signal,
  fetchImpl = fetch,
  sleep,
  maxAttempts = RECORDING_POLL_LIMIT,
  intervalMs = RECORDING_POLL_INTERVAL_MS,
}: PollRecordingOptions): Promise<LiveRecordingState> {
  const lookupUrl = new URL(backendUrl);
  lookupUrl.searchParams.set("recordingWorkflowId", reference.workflowId);
  lookupUrl.searchParams.set("startedAt", reference.startedAt);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(lookupUrl, {
      method: "GET",
      headers: { "X-Judge-PIN": judgePin },
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(`Recording lookup failed with HTTP ${response.status}`);

    const body = (await response.json()) as Record<string, unknown>;
    const ready = readyState(body);
    if (ready) return ready;
    if (body.status === "DISABLED") return { status: "disabled" };
    if (body.status !== "PROCESSING") throw new Error("Unexpected recording lookup response");

    if (attempt < maxAttempts) {
      if (sleep) await sleep(intervalMs);
      else await wait(intervalMs, signal);
    }
  }

  return { status: "unavailable" };
}
