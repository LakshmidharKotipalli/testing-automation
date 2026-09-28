import { InvalidTransitionError } from "./errors.js";
import type { AgentInstanceState, HandoffState, RunState, WorkPacketState } from "./schemas/runtime.js";

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  allowedFrom(from: S): readonly S[];
  isTerminal(state: S): boolean;
}

export function defineStateMachine<S extends string>(
  name: string,
  transitions: Record<S, readonly S[]>,
): StateMachine<S> {
  const states = Object.keys(transitions) as S[];
  const terminal = states.filter((s) => transitions[s].length === 0);
  return {
    name,
    states,
    terminal,
    canTransition: (from, to) => transitions[from]?.includes(to) ?? false,
    assertTransition(from, to) {
      if (!this.canTransition(from, to)) throw new InvalidTransitionError(name, from, to);
    },
    allowedFrom: (from) => transitions[from] ?? [],
    isTerminal: (state) => transitions[state]?.length === 0,
  };
}

/**
 * Only APPROVED -> RUNNING may initiate test execution. Rejection moves PENDING_APPROVAL -> CANCELLED.
 *
 * Two planning paths reach EXECUTION_PLAN_GENERATED:
 * - instruction-led: DRAFT -> COMPILED -> VALIDATED
 * - autonomous: DRAFT -> DISCOVERY_PLANNED -> DISCOVERY_RUNNING -> DISCOVERY_COMPLETED
 *   -> WEBSITE_PROFILE_GENERATED -> TEST_PLAN_GENERATED
 * Only the single read-only Discovery Lead Agent may run during DISCOVERY_RUNNING.
 */
export const runStateMachine = defineStateMachine<RunState>("run", {
  DRAFT: ["COMPILED", "DISCOVERY_PLANNED", "FAILED", "CANCELLED"],
  DISCOVERY_PLANNED: ["DISCOVERY_RUNNING", "FAILED", "CANCELLED"],
  DISCOVERY_RUNNING: ["DISCOVERY_COMPLETED", "FAILED", "CANCELLED"],
  DISCOVERY_COMPLETED: ["WEBSITE_PROFILE_GENERATED", "FAILED", "CANCELLED"],
  WEBSITE_PROFILE_GENERATED: ["TEST_PLAN_GENERATED", "FAILED", "CANCELLED"],
  TEST_PLAN_GENERATED: ["EXECUTION_PLAN_GENERATED", "FAILED", "CANCELLED"],
  COMPILED: ["VALIDATED", "FAILED", "CANCELLED"],
  VALIDATED: ["EXECUTION_PLAN_GENERATED", "FAILED", "CANCELLED"],
  EXECUTION_PLAN_GENERATED: ["PENDING_APPROVAL", "FAILED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "CANCELLED"],
  APPROVED: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
});

export const workPacketStateMachine = defineStateMachine<WorkPacketState>("work-packet", {
  PENDING: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["CHECKPOINTING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  CHECKPOINTING: ["RUNNING", "HANDOFF_PENDING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  HANDOFF_PENDING: ["RESUMING", "FAILED", "BLOCKED", "CANCELLED"],
  RESUMING: ["RUNNING", "FAILED", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
});

export const agentInstanceStateMachine = defineStateMachine<AgentInstanceState>("agent-instance", {
  CREATED: ["STARTING", "TERMINATED"],
  STARTING: ["ACTIVE", "TERMINATED"],
  ACTIVE: ["CONTEXT_WARNING", "CHECKPOINTING", "TERMINATED"],
  CONTEXT_WARNING: ["CHECKPOINTING", "TERMINATED"],
  CHECKPOINTING: ["ACTIVE", "TERMINATED"],
  TERMINATED: ["REPLACED"],
  REPLACED: [],
});

export const handoffStateMachine = defineStateMachine<HandoffState>("handoff", {
  NOT_REQUIRED: ["REQUIRED"],
  REQUIRED: ["WRITING"],
  WRITING: ["VALIDATED"],
  VALIDATED: ["PERSISTED"],
  PERSISTED: ["CONSUMED"],
  CONSUMED: ["COMPLETED"],
  COMPLETED: [],
});

/**
 * Small stateful wrapper that enforces a machine and reports every transition to a listener
 * (the orchestrator persists these as events).
 */
export class TrackedState<S extends string> {
  private history: { state: S; at: string; reason?: string }[] = [];

  constructor(
    private readonly machine: StateMachine<S>,
    private current: S,
    private readonly onTransition: (from: S, to: S, reason?: string) => void = () => {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.history.push({ state: current, at: this.now() });
  }

  get state(): S {
    return this.current;
  }

  get transitions(): readonly { state: S; at: string; reason?: string }[] {
    return this.history;
  }

  to(next: S, reason?: string): void {
    this.machine.assertTransition(this.current, next);
    const from = this.current;
    this.current = next;
    this.history.push(
      reason === undefined ? { state: next, at: this.now() } : { state: next, at: this.now(), reason },
    );
    this.onTransition(from, next, reason);
  }

  isTerminal(): boolean {
    return this.machine.isTerminal(this.current);
  }
}
