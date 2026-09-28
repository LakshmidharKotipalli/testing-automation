import type {
  CheckpointReason,
  ContextPolicy,
  ContextUsage,
  ContextWarning,
  LifecycleTrigger,
  ModelRef,
  TokenUsage,
} from "@browserswarm/core";
import { estimateTokens } from "@browserswarm/opencode-adapter";
import { systemClock, type Clock } from "@browserswarm/shared";

/** Used only when neither the provider nor the policy/model declares a context window. Deliberately small. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;

export type LifecycleDecision =
  | { kind: "continue" }
  /** A browser action is in flight: never interrupt; re-evaluate after it completes. */
  | { kind: "defer"; pending: LifecycleTrigger[] }
  /** Soft warning: emit agent.context.warning and checkpoint proactively after the current step. */
  | { kind: "warn"; trigger: "context_warning"; warning: ContextWarning; checkpointReason: CheckpointReason }
  /** Checkpoint, write a handoff, terminate this instance, and (if work remains) start a replacement. */
  | { kind: "rotate"; trigger: LifecycleTrigger; reason: string; checkpointReason: CheckpointReason }
  /** Before a risky action: persist a checkpoint first, then run the normal policy checks. */
  | { kind: "checkpoint_before_risky_action"; checkpointReason: "before_risky_action" };

export interface EvaluateInput {
  actionInFlight?: boolean;
  nextStepRisky?: boolean;
}

export interface LifecycleManagerOptions {
  agentInstanceId: string;
  model?: ModelRef | null;
  clock?: Clock;
  /** Fallback context window when neither provider, model ref nor policy states one. */
  defaultContextWindowTokens?: number;
}

const TRIGGER_TO_REASON: Record<LifecycleTrigger, CheckpointReason> = {
  context_warning: "context_warning",
  context_hard_limit: "context_hard_limit",
  input_token_budget: "context_hard_limit",
  output_token_budget: "context_hard_limit",
  total_token_budget: "context_hard_limit",
  message_limit: "context_hard_limit",
  action_limit: "action_limit",
  duration_limit: "duration_limit",
  fallback_limit: "model_error",
  model_error: "model_error",
  manual: "manual",
};

/**
 * Tracks one agent instance's context consumption and decides when it must be checkpointed and replaced.
 * Exact provider-reported token counts win; otherwise conservative estimates are used. All limits are
 * evaluated between actions only, and the earliest applicable trigger (by priority) wins.
 */
export class ContextLifecycleManager {
  private readonly clock: Clock;
  private readonly startedAtMs: number;
  private readonly startedAt: string;
  private exactInput?: number;
  private exactOutput?: number;
  private estimatedInput = 0;
  private estimatedOutput = 0;
  private reportedWindow?: number;
  private messages = 0;
  private actions = 0;
  private llmCalls = 0;
  private consecutiveFallbacks = 0;
  private modelErrors = 0;
  private manualRequested = false;
  private warned = false;

  constructor(
    private readonly policy: ContextPolicy,
    private readonly options: LifecycleManagerOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.startedAtMs = this.clock.now();
    this.startedAt = this.clock.iso();
  }

  /** Records an LLM exchange. `usage.exact` values override estimates for this instance. */
  recordLlmCall(input: {
    promptText: string;
    outputText: string;
    usage?: TokenUsage;
    contextWindowTokens?: number;
  }): void {
    this.llmCalls++;
    this.messages += 2;
    this.estimatedInput += estimateTokens(input.promptText).tokens;
    this.estimatedOutput += estimateTokens(input.outputText).tokens;
    if (input.usage?.exact) {
      // Providers report per-call input which already includes the running conversation; keep the max.
      this.exactInput = Math.max(this.exactInput ?? 0, input.usage.inputTokens);
      this.exactOutput = (this.exactOutput ?? 0) + input.usage.outputTokens;
    }
    if (input.contextWindowTokens) this.reportedWindow = input.contextWindowTokens;
  }

  /** Records structured observations added to the agent's context (tool results, page summaries). */
  recordObservation(text: string): void {
    this.messages++;
    this.estimatedInput += estimateTokens(text).tokens;
  }

  recordBrowserAction(): void {
    this.actions++;
  }

  recordFallback(succeeded: boolean): void {
    this.consecutiveFallbacks = succeeded ? 0 : this.consecutiveFallbacks + 1;
  }

  recordModelError(): void {
    this.modelErrors++;
    this.consecutiveFallbacks++;
  }

  requestManualRotation(): void {
    this.manualRequested = true;
  }

  get contextWindowTokens(): number {
    return (
      this.reportedWindow ??
      this.options.model?.contextWindowTokens ??
      this.policy.modelContextWindowTokens ??
      this.options.defaultContextWindowTokens ??
      DEFAULT_CONTEXT_WINDOW_TOKENS
    );
  }

  private inputTokens(): number {
    return this.exactInput ?? this.estimatedInput;
  }
  private outputTokens(): number {
    return this.exactOutput ?? this.estimatedOutput;
  }
  private totalTokens(): number {
    return this.inputTokens() + this.outputTokens();
  }

  /** Effective window: the smaller of the model window and the per-instance total token budget. */
  private effectiveWindow(): number {
    const budget = this.policy.maxEstimatedTotalTokensPerAgentInstance;
    return budget ? Math.min(budget, this.contextWindowTokens) : this.contextWindowTokens;
  }

  utilizationPercent(): number {
    return Math.round((this.totalTokens() / this.effectiveWindow()) * 1000) / 10;
  }

  getUsage(): ContextUsage {
    const usage: ContextUsage = {
      agentInstanceId: this.options.agentInstanceId,
      estimatedInputTokens: this.estimatedInput,
      estimatedOutputTokens: this.estimatedOutput,
      estimatedTotalTokens: this.estimatedInput + this.estimatedOutput,
      contextWindowTokens: this.effectiveWindow(),
      contextUtilizationPercent: this.utilizationPercent(),
      messageCount: this.messages,
      browserActionCount: this.actions,
      llmCallCount: this.llmCalls,
      startedAt: this.startedAt,
      updatedAt: this.clock.iso(),
    };
    if (this.options.model) usage.model = this.options.model;
    if (this.exactInput !== undefined) usage.exactInputTokens = this.exactInput;
    if (this.exactOutput !== undefined) usage.exactOutputTokens = this.exactOutput;
    return usage;
  }

  /** All triggers currently satisfied, in priority order. */
  activeTriggers(): LifecycleTrigger[] {
    const p = this.policy;
    const t: LifecycleTrigger[] = [];
    if (!p.enabled) return t;
    const util = this.utilizationPercent();
    if (this.manualRequested) t.push("manual");
    if (util >= p.contextHardStopThresholdPercent) t.push("context_hard_limit");
    if (
      p.maxEstimatedInputTokensPerAgentInstance &&
      this.inputTokens() >= p.maxEstimatedInputTokensPerAgentInstance
    )
      t.push("input_token_budget");
    if (
      p.maxEstimatedOutputTokensPerAgentInstance &&
      this.outputTokens() >= p.maxEstimatedOutputTokensPerAgentInstance
    )
      t.push("output_token_budget");
    if (
      p.maxEstimatedTotalTokensPerAgentInstance &&
      this.totalTokens() >= p.maxEstimatedTotalTokensPerAgentInstance
    )
      t.push("total_token_budget");
    if (p.maxMessagesPerAgentInstance && this.messages >= p.maxMessagesPerAgentInstance)
      t.push("message_limit");
    if (p.maxActionsPerAgentInstance && this.actions >= p.maxActionsPerAgentInstance) t.push("action_limit");
    if (
      p.maxDurationMsPerAgentInstance &&
      this.clock.now() - this.startedAtMs >= p.maxDurationMsPerAgentInstance
    )
      t.push("duration_limit");
    if (p.maxConsecutiveFallbackCalls && this.consecutiveFallbacks >= p.maxConsecutiveFallbackCalls)
      t.push("fallback_limit");
    if (this.modelErrors > 0 && this.consecutiveFallbacks > 0 && !t.includes("fallback_limit"))
      t.push("model_error");
    if (util >= p.contextWarningThresholdPercent && !t.includes("context_hard_limit"))
      t.push("context_warning");
    return t;
  }

  /**
   * Decide what to do now. Call only between actions; if an action is in flight the decision is deferred.
   * `nextStepRisky` forces a checkpoint before a risky action when the policy asks for it.
   */
  evaluate(input: EvaluateInput = {}): LifecycleDecision {
    const triggers = this.activeTriggers();
    if (input.actionInFlight)
      return triggers.length ? { kind: "defer", pending: triggers } : { kind: "continue" };
    const hard = triggers.find((t) => t !== "context_warning");
    if (hard) {
      return {
        kind: "rotate",
        trigger: hard,
        reason: this.describe(hard),
        checkpointReason: TRIGGER_TO_REASON[hard],
      };
    }
    if (triggers.includes("context_warning") && !this.warned) {
      this.warned = true;
      return {
        kind: "warn",
        trigger: "context_warning",
        checkpointReason: "context_warning",
        warning: {
          agentInstanceId: this.options.agentInstanceId,
          trigger: "context_warning",
          utilizationPercent: this.utilizationPercent(),
          thresholdPercent: this.policy.contextWarningThresholdPercent,
          message: this.describe("context_warning"),
          at: this.clock.iso(),
        },
      };
    }
    if (input.nextStepRisky && this.policy.checkpointBeforeRiskyAction) {
      return { kind: "checkpoint_before_risky_action", checkpointReason: "before_risky_action" };
    }
    return { kind: "continue" };
  }

  private describe(trigger: LifecycleTrigger): string {
    const p = this.policy;
    switch (trigger) {
      case "context_warning":
        return `context utilization ${this.utilizationPercent()}% reached warning threshold ${p.contextWarningThresholdPercent}%`;
      case "context_hard_limit":
        return `context utilization ${this.utilizationPercent()}% reached hard-stop threshold ${p.contextHardStopThresholdPercent}%`;
      case "input_token_budget":
        return `input tokens ${this.inputTokens()} reached budget ${p.maxEstimatedInputTokensPerAgentInstance}`;
      case "output_token_budget":
        return `output tokens ${this.outputTokens()} reached budget ${p.maxEstimatedOutputTokensPerAgentInstance}`;
      case "total_token_budget":
        return `total tokens ${this.totalTokens()} reached budget ${p.maxEstimatedTotalTokensPerAgentInstance}`;
      case "message_limit":
        return `message count ${this.messages} reached limit ${p.maxMessagesPerAgentInstance}`;
      case "action_limit":
        return `agent-instance action count ${this.actions} reached limit ${p.maxActionsPerAgentInstance}`;
      case "duration_limit":
        return `agent-instance duration reached limit ${p.maxDurationMsPerAgentInstance}ms`;
      case "fallback_limit":
        return `consecutive fallback/model failures reached limit ${p.maxConsecutiveFallbackCalls}`;
      case "model_error":
        return `model error (${this.modelErrors} total)`;
      case "manual":
        return "manual rotation requested";
    }
    return String(trigger);
  }
}
