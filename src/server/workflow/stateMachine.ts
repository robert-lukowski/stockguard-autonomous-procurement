export type WorkflowState =
  | "IDLE"
  | "DEMAND_DETECTED"
  | "CONTACTS_PLANNED"
  | "CALLING"
  | "OFFER_RECEIVED"
  | "VALIDATING"
  | "POLICY_CHECK"
  | "SELECTED"
  | "HUMAN_REVIEW"
  | "ORDER_PREPARED"
  | "PROOF_SIGNED"
  | "FAILED"
  | "CANCELLED";

export type WorkflowStateEvent = {
  runId: string;
  sequence: number;
  from: WorkflowState;
  to: WorkflowState;
  at: string;
  reason: string;
};

const transitions: Record<WorkflowState, WorkflowState[]> = {
  IDLE: ["DEMAND_DETECTED", "FAILED", "CANCELLED"],
  DEMAND_DETECTED: ["CONTACTS_PLANNED", "HUMAN_REVIEW", "FAILED", "CANCELLED"],
  CONTACTS_PLANNED: ["CALLING", "FAILED", "CANCELLED"],
  CALLING: ["OFFER_RECEIVED", "HUMAN_REVIEW", "FAILED", "CANCELLED"],
  OFFER_RECEIVED: ["CALLING", "VALIDATING", "HUMAN_REVIEW", "FAILED", "CANCELLED"],
  VALIDATING: ["POLICY_CHECK", "HUMAN_REVIEW", "FAILED", "CANCELLED"],
  POLICY_CHECK: ["SELECTED", "HUMAN_REVIEW", "FAILED", "CANCELLED"],
  SELECTED: ["ORDER_PREPARED", "HUMAN_REVIEW", "FAILED", "CANCELLED"],
  HUMAN_REVIEW: [],
  ORDER_PREPARED: ["PROOF_SIGNED", "FAILED"],
  PROOF_SIGNED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTransitionAllowed(from: WorkflowState, to: WorkflowState): boolean {
  return transitions[from].includes(to);
}

export class ProcurementStateMachine {
  private state: WorkflowState = "IDLE";
  private readonly events: WorkflowStateEvent[] = [];

  constructor(
    private readonly runId: string,
    private readonly clock: () => Date,
    private readonly observer?: (event: WorkflowStateEvent) => void,
  ) {}

  get current(): WorkflowState {
    return this.state;
  }

  get history(): WorkflowStateEvent[] {
    return [...this.events];
  }

  transition(to: WorkflowState, reason: string): WorkflowStateEvent {
    if (!isTransitionAllowed(this.state, to)) {
      throw new Error(`Invalid workflow transition ${this.state} -> ${to}`);
    }
    const event: WorkflowStateEvent = {
      runId: this.runId,
      sequence: this.events.length + 1,
      from: this.state,
      to,
      at: this.clock().toISOString(),
      reason,
    };
    this.events.push(event);
    this.state = to;
    this.observer?.(event);
    return event;
  }
}

export function appendWorkflowState(
  history: WorkflowStateEvent[],
  to: WorkflowState,
  reason: string,
  at: string,
): WorkflowStateEvent[] {
  const from = history.at(-1)?.to ?? "IDLE";
  if (!isTransitionAllowed(from, to)) {
    throw new Error(`Invalid workflow transition ${from} -> ${to}`);
  }
  return [
    ...history,
    {
      runId: history[0]?.runId ?? "unknown",
      sequence: history.length + 1,
      from,
      to,
      at,
      reason,
    },
  ];
}
