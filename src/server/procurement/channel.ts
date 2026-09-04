import { findMission } from "./missions";
import type { ConfirmationResult, RunReport, TurnResult } from "./ProcurementOrchestrator";
import type { JudgeMission } from "./types";

/**
 * What a channel has to do, and nothing more.
 *
 * A channel carries text in and renders results out. It holds no procurement
 * logic, no catalog, no policy and no supplier access — those live behind the
 * tool boundary, which is why the same orchestrator can serve a browser text
 * box today and an Amazon Connect WebRTC contact later without changing a
 * decision rule.
 *
 * Implementations planned:
 *   - `LocalTextChannel`             (here; Judge Portal and tests)
 *   - Connect WebRTC + Lex adapter   (see `src/server/webrtc`, not deployed)
 *   - Chat / API adapters            (deferred)
 *   - human-answered supplier leg    (deferred; the CALL-E port already models it)
 */
export interface ProcurementChannel {
  readonly channelId: string;
  start(missionId: string): Promise<{ sessionId: string; mission: JudgeMission }>;
  say(sessionId: string, text: string): Promise<TurnResult>;
  decide(
    sessionId: string,
    evaluationId: string,
    confirmationToken: string,
    accepted: boolean,
  ): Promise<ConfirmationResult>;
  escalate(sessionId: string, evaluationId: string): Promise<ConfirmationResult>;
  report(sessionId: string): Promise<RunReport>;
}

type OrchestratorLike = {
  startSession(missionId: string): { sessionId: string; missionId: string };
  handleUtterance(sessionId: string, text: string): Promise<TurnResult>;
  confirm(
    sessionId: string,
    evaluationId: string,
    confirmationToken: string,
    accepted: boolean,
  ): Promise<ConfirmationResult>;
  escalate(sessionId: string, evaluationId: string): Promise<ConfirmationResult>;
  report(sessionId: string): Promise<RunReport>;
};

/**
 * The telephony-free channel.
 *
 * This is the whole vertical slice's transport: text in, structured result
 * out. It is what the Judge Portal uses today and what every test drives, so
 * the procurement path is exercised end to end without AWS, without a phone
 * number and without a browser microphone.
 */
export class LocalTextChannel implements ProcurementChannel {
  readonly channelId = "local-text";

  constructor(private readonly orchestrator: OrchestratorLike) {}

  /**
   * Opens a session only.
   *
   * Deliberately does NOT send an empty first utterance: an empty product
   * query resolves to OUT_OF_DOMAIN, which would end the run before the judge
   * had said anything.
   */
  async start(missionId: string): Promise<{ sessionId: string; mission: JudgeMission }> {
    const mission = findMission(missionId);
    if (!mission) throw new Error(`Unknown mission ${missionId}`);
    const session = this.orchestrator.startSession(missionId);
    return { sessionId: session.sessionId, mission };
  }

  say(sessionId: string, text: string): Promise<TurnResult> {
    return this.orchestrator.handleUtterance(sessionId, text);
  }

  decide(
    sessionId: string,
    evaluationId: string,
    confirmationToken: string,
    accepted: boolean,
  ): Promise<ConfirmationResult> {
    return this.orchestrator.confirm(sessionId, evaluationId, confirmationToken, accepted);
  }

  escalate(sessionId: string, evaluationId: string): Promise<ConfirmationResult> {
    return this.orchestrator.escalate(sessionId, evaluationId);
  }

  report(sessionId: string): Promise<RunReport> {
    return this.orchestrator.report(sessionId);
  }
}
