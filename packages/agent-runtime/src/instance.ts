import {
  agentInstanceStateMachine,
  TrackedState,
  type AgentInstance,
  type AgentInstanceState,
  type ModelRef,
} from "@browserswarm/core";
import { padSequence, shortRandom, systemClock, type Clock } from "@browserswarm/shared";

export interface CreateInstanceInput {
  runId: string;
  workPacketId: string;
  sequence: number;
  kind: "scripted" | "llm";
  model: ModelRef | null;
  previousAgentInstanceId?: string;
  sourceHandoffId?: string;
  clock?: Clock;
  onTransition?: (
    instance: AgentInstance,
    from: AgentInstanceState,
    to: AgentInstanceState,
    reason?: string,
  ) => void;
}

/**
 * A disposable worker bound to exactly one work packet. Instances may be rotated many times; the packet
 * never changes. Every state change is enforced by the agent-instance state machine.
 */
export class AgentInstanceHandle {
  readonly record: AgentInstance;
  private readonly state: TrackedState<AgentInstanceState>;
  private readonly clock: Clock;

  constructor(input: CreateInstanceInput) {
    this.clock = input.clock ?? systemClock;
    this.record = {
      agentInstanceId: `agent-${padSequence(input.sequence, 3)}-${shortRandom(3)}`,
      runId: input.runId,
      workPacketId: input.workPacketId,
      sequence: input.sequence,
      kind: input.kind,
      state: "CREATED",
      model: input.model,
      startedAt: this.clock.iso(),
      actionsExecuted: 0,
      ...(input.previousAgentInstanceId ? { previousAgentInstanceId: input.previousAgentInstanceId } : {}),
      ...(input.sourceHandoffId ? { sourceHandoffId: input.sourceHandoffId } : {}),
    };
    this.state = new TrackedState(
      agentInstanceStateMachine,
      "CREATED",
      (from, to, reason) => {
        this.record.state = to;
        if (to === "TERMINATED") {
          this.record.endedAt = this.clock.iso();
          if (reason) this.record.terminationReason = reason;
        }
        input.onTransition?.(this.record, from, to, reason);
      },
      () => this.clock.iso(),
    );
  }

  get id(): string {
    return this.record.agentInstanceId;
  }

  get current(): AgentInstanceState {
    return this.state.state;
  }

  to(next: AgentInstanceState, reason?: string): void {
    this.state.to(next, reason);
  }

  /** Terminates from any live state (CHECKPOINTING path is used when a checkpoint precedes termination). */
  terminate(reason: string): void {
    if (this.current === "TERMINATED" || this.current === "REPLACED") return;
    this.to("TERMINATED", reason);
  }

  countAction(): void {
    this.record.actionsExecuted++;
  }
}
