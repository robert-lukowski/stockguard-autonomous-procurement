import type {
  CreateJudgeSessionRequest,
  JudgeRunStatus,
  JudgeSession,
  StartManagerCallRequest,
  StartManagerCallResponse,
} from "./types";

type FetchLike = typeof fetch;

type JudgeModeBackendConfig = {
  baseUrl?: string;
  fetchImplementation?: FetchLike;
};

export class JudgeModeBackendUnavailableError extends Error {}

export class JudgeModeBackendClient {
  private readonly fetchImplementation: FetchLike;

  constructor(private readonly config: JudgeModeBackendConfig = {}) {
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  private endpoint(path: string): string {
    if (!this.config.baseUrl) {
      throw new JudgeModeBackendUnavailableError(
        "Live Judge Mode backend is not configured; no call can be started",
      );
    }
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async createSession(request: CreateJudgeSessionRequest): Promise<JudgeSession> {
    if (request.accessCode.trim().length === 0) throw new Error("Access code is required");
    const response = await this.fetchImplementation(this.endpoint("/judge/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Judge session authorization failed with HTTP ${response.status}`);
    return (await response.json()) as JudgeSession;
  }

  async startManagerCall(
    session: JudgeSession,
    request: StartManagerCallRequest,
  ): Promise<StartManagerCallResponse> {
    if (!request.explicitConsent) throw new Error("Explicit consent is required");
    const response = await this.fetchImplementation(
      this.endpoint(`/judge/sessions/${encodeURIComponent(session.sessionId)}/manager-calls`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) throw new Error(`Manager escalation request failed with HTTP ${response.status}`);
    return (await response.json()) as StartManagerCallResponse;
  }

  async getRunStatus(session: JudgeSession, runId: string): Promise<JudgeRunStatus> {
    const response = await this.fetchImplementation(
      this.endpoint(`/judge/runs/${encodeURIComponent(runId)}`),
      {
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "X-Judge-Session": session.sessionId,
        },
      },
    );
    if (!response.ok) throw new Error(`Judge run lookup failed with HTTP ${response.status}`);
    return (await response.json()) as JudgeRunStatus;
  }
}
