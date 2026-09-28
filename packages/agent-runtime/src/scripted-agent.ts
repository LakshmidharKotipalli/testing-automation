import { ContextLifecycleManager } from "@browserswarm/context-lifecycle";
import type { AgentEventType, CheckpointReason, LifecycleTrigger, WorkPacket } from "@browserswarm/core";
import type { Clock } from "@browserswarm/shared";
import type { AgentInstanceHandle } from "./instance.js";

export type StepStatusResult = "passed" | "failed" | "blocked" | "skipped";

/**
 * Services the orchestrator provides to an agent. The agent never touches Playwright, storage or policy
 * directly: `executeStep` performs the policy check, the typed action, ledger/evidence persistence and
 * finding creation for one approved step.
 */
export interface AgentHost {
  readonly packet: WorkPacket;
  readonly signal: AbortSignal;
  actionsUsed(): number;
  deadlineReached(): boolean;
  isStepRisky(index: number): boolean;
  executeStep(index: number, agent: AgentInstanceHandle): Promise<StepStatusResult>;
  /** Persists a checkpoint whose resume index is `nextIndex`. Throws if persistence fails. */
  checkpoint(reason: CheckpointReason, agent: AgentInstanceHandle, nextIndex: number): Promise<void>;
  emit(type: AgentEventType, agent: AgentInstanceHandle, data: Record<string, unknown>): void;
}

export type AgentRunResult =
  | { kind: "completed" }
  | { kind: "failed"; stepIndex: number }
  | { kind: "blocked"; stepIndex: number; reason: string }
  | {
      kind: "rotation_required";
      nextIndex: number;
      trigger: LifecycleTrigger;
      reason: string;
      checkpointReason: CheckpointReason;
    }
  | { kind: "budget_exhausted"; nextIndex: number; reason: string }
  | { kind: "cancelled"; nextIndex: number };

/**
 * Deterministic scripted agent: executes the packet's approved steps in order with zero LLM calls.
 * Lifecycle limits are evaluated only between steps, so an in-flight browser action is never interrupted.
 */
export class ScriptedAgent {
  readonly lifecycle: ContextLifecycleManager;

  constructor(
    readonly instance: AgentInstanceHandle,
    private readonly packet: WorkPacket,
    clock: Clock,
  ) {
    this.lifecycle = new ContextLifecycleManager(packet.contextPolicy, {
      agentInstanceId: instance.id,
      model: packet.model,
      clock,
    });
  }

  async run(host: AgentHost, startIndex: number): Promise<AgentRunResult> {
    const agent = this.instance;
    const policy = this.packet.contextPolicy;
    if (agent.current === "CREATED") agent.to("STARTING");
    if (agent.current === "STARTING") agent.to("ACTIVE");

    for (let i = startIndex; i < this.packet.steps.length; i++) {
      if (host.signal.aborted) return { kind: "cancelled", nextIndex: i };
      if (host.deadlineReached())
        return { kind: "budget_exhausted", nextIndex: i, reason: "work packet timeout reached" };
      if (host.actionsUsed() >= this.packet.actionBudget) {
        return {
          kind: "budget_exhausted",
          nextIndex: i,
          reason: `action budget ${this.packet.actionBudget} exhausted`,
        };
      }

      const decision = this.lifecycle.evaluate({ nextStepRisky: host.isStepRisky(i) });
      if (decision.kind === "rotate") {
        host.emit("agent.context.limit_reached", agent, {
          trigger: decision.trigger,
          reason: decision.reason,
          nextIndex: i,
        });
        return {
          kind: "rotation_required",
          nextIndex: i,
          trigger: decision.trigger,
          reason: decision.reason,
          checkpointReason: decision.checkpointReason,
        };
      }
      if (decision.kind === "warn") {
        host.emit("agent.context.warning", agent, { ...decision.warning });
        agent.to("CONTEXT_WARNING", decision.warning.message);
        if (policy.checkpointOnContextWarning) {
          agent.to("CHECKPOINTING");
          host.emit("agent.checkpointing", agent, { reason: "context_warning" });
          await host.checkpoint("context_warning", agent, i);
          agent.to("ACTIVE");
        }
      }
      if (decision.kind === "checkpoint_before_risky_action") {
        agent.to("CHECKPOINTING");
        host.emit("agent.checkpointing", agent, { reason: "before_risky_action", stepIndex: i });
        await host.checkpoint("before_risky_action", agent, i);
        agent.to("ACTIVE");
      }

      const status = await host.executeStep(i, agent);
      this.lifecycle.recordBrowserAction();
      agent.countAction();
      if (status === "failed") return { kind: "failed", stepIndex: i };
      if (status === "blocked") return { kind: "blocked", stepIndex: i, reason: "blocked by safety policy" };
      if (policy.checkpointAfterEveryStep) await host.checkpoint("step_completed", agent, i + 1);
    }
    return { kind: "completed" };
  }
}
