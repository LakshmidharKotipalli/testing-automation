import { ContextPolicySchema, type ContextPolicy } from "@browserswarm/core";
import { FakeClock } from "@browserswarm/shared";
import { describe, expect, it } from "vitest";
import { ContextLifecycleManager, DEFAULT_CONTEXT_WINDOW_TOKENS } from "../src/index.js";

const policy = (p: Partial<ContextPolicy> = {}) => ContextPolicySchema.parse(p);
const mgr = (p: Partial<ContextPolicy> = {}, window?: number, clock = new FakeClock()) =>
  new ContextLifecycleManager(policy(p), {
    agentInstanceId: "agent-1",
    clock,
    model: window ? { provider: "mock", model: "m", contextWindowTokens: window } : null,
  });

describe("context accounting", () => {
  it("uses exact provider usage when reported", () => {
    const m = mgr({}, 10_000);
    m.recordLlmCall({
      promptText: "x".repeat(35),
      outputText: "y".repeat(35),
      usage: { inputTokens: 5000, outputTokens: 100, totalTokens: 5100, exact: true },
    });
    const u = m.getUsage();
    expect(u.exactInputTokens).toBe(5000);
    expect(u.exactOutputTokens).toBe(100);
    expect(u.contextUtilizationPercent).toBe(51);
  });

  it("falls back to conservative estimates", () => {
    const m = mgr({}, 1000);
    m.recordLlmCall({ promptText: "a".repeat(700), outputText: "b".repeat(70) });
    const u = m.getUsage();
    expect(u.exactInputTokens).toBeUndefined();
    expect(u.estimatedInputTokens).toBe(200);
    expect(u.estimatedOutputTokens).toBe(20);
    expect(u.contextUtilizationPercent).toBe(22);
  });

  it("does not assume one context size for every model", () => {
    expect(mgr({}).contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(mgr({ modelContextWindowTokens: 64_000 }).contextWindowTokens).toBe(64_000);
    expect(mgr({ modelContextWindowTokens: 64_000 }, 8000).contextWindowTokens).toBe(8000);
    const m = mgr({}, 8000);
    m.recordLlmCall({ promptText: "p", outputText: "o", contextWindowTokens: 200_000 });
    expect(m.contextWindowTokens).toBe(200_000);
  });
});

describe("rotation triggers", () => {
  const exact = (m: ContextLifecycleManager, input: number) =>
    m.recordLlmCall({
      promptText: "p",
      outputText: "o",
      usage: { inputTokens: input, outputTokens: 0, totalTokens: input, exact: true },
    });

  it("warns once at the warning threshold, then rotates at the hard stop", () => {
    const m = mgr({ contextWarningThresholdPercent: 75, contextHardStopThresholdPercent: 85 }, 1000);
    exact(m, 700);
    expect(m.evaluate().kind).toBe("continue");
    exact(m, 760);
    const w = m.evaluate();
    expect(w.kind).toBe("warn");
    expect(m.evaluate().kind).toBe("continue");
    exact(m, 860);
    const r = m.evaluate();
    expect(r).toMatchObject({
      kind: "rotate",
      trigger: "context_hard_limit",
      checkpointReason: "context_hard_limit",
    });
  });

  it("per-instance token budgets", () => {
    const m = mgr({ maxEstimatedTotalTokensPerAgentInstance: 500 }, 100_000);
    exact(m, 300);
    // Utilization is measured against min(model window, per-instance budget).
    expect(m.getUsage().contextUtilizationPercent).toBe(60);
    exact(m, 500);
    expect(m.activeTriggers()).toContain("total_token_budget");
    expect(m.evaluate().kind).toBe("rotate");
  });

  it("message count limit", () => {
    const m = mgr({ maxMessagesPerAgentInstance: 3 }, 100_000);
    m.recordObservation("a");
    m.recordObservation("b");
    expect(m.evaluate().kind).toBe("continue");
    m.recordObservation("c");
    expect(m.evaluate()).toMatchObject({ kind: "rotate", trigger: "message_limit" });
  });

  it("action limit enables planned rotation without token data", () => {
    const m = mgr({ maxActionsPerAgentInstance: 2 });
    m.recordBrowserAction();
    expect(m.evaluate().kind).toBe("continue");
    m.recordBrowserAction();
    expect(m.evaluate()).toMatchObject({
      kind: "rotate",
      trigger: "action_limit",
      checkpointReason: "action_limit",
    });
  });

  it("duration limit", () => {
    const clock = new FakeClock();
    const m = mgr({ maxDurationMsPerAgentInstance: 60_000 }, undefined, clock);
    clock.advance(59_000);
    expect(m.evaluate().kind).toBe("continue");
    clock.advance(1_000);
    expect(m.evaluate()).toMatchObject({ kind: "rotate", trigger: "duration_limit" });
  });

  it("model errors and repeated fallbacks rotate the instance", () => {
    const m = mgr({ maxConsecutiveFallbackCalls: 2 });
    m.recordModelError();
    expect(m.evaluate()).toMatchObject({
      kind: "rotate",
      trigger: "model_error",
      checkpointReason: "model_error",
    });
    const n = mgr({ maxConsecutiveFallbackCalls: 2 });
    n.recordFallback(false);
    n.recordFallback(false);
    expect(n.evaluate()).toMatchObject({ kind: "rotate", trigger: "fallback_limit" });
  });

  it("manual rotation is supported", () => {
    const m = mgr();
    m.requestManualRotation();
    expect(m.evaluate()).toMatchObject({ kind: "rotate", trigger: "manual", checkpointReason: "manual" });
  });

  it("never interrupts an in-flight browser action", () => {
    const m = mgr({ maxActionsPerAgentInstance: 1 });
    m.recordBrowserAction();
    expect(m.evaluate({ actionInFlight: true })).toMatchObject({ kind: "defer", pending: ["action_limit"] });
    expect(m.evaluate().kind).toBe("rotate");
  });

  it("uses the highest-priority trigger when several apply", () => {
    const m = mgr({ maxActionsPerAgentInstance: 1, contextHardStopThresholdPercent: 85 }, 1000);
    m.recordBrowserAction();
    exact(m, 900);
    expect(m.evaluate()).toMatchObject({ trigger: "context_hard_limit" });
  });

  it("checkpoints before risky actions", () => {
    expect(mgr().evaluate({ nextStepRisky: true }).kind).toBe("checkpoint_before_risky_action");
    expect(mgr({ checkpointBeforeRiskyAction: false }).evaluate({ nextStepRisky: true }).kind).toBe(
      "continue",
    );
  });

  it("does nothing when disabled", () => {
    const m = mgr({ enabled: false, maxActionsPerAgentInstance: 1 });
    m.recordBrowserAction();
    expect(m.evaluate().kind).toBe("continue");
  });
});
