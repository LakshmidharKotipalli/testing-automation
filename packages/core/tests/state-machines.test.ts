import { describe, expect, it } from "vitest";
import {
  agentInstanceStateMachine,
  handoffStateMachine,
  InvalidTransitionError,
  runStateMachine,
  TrackedState,
  workPacketStateMachine,
} from "../src/index.js";

describe("run state machine", () => {
  it("follows the approval-first lifecycle", () => {
    const seen: string[] = [];
    const s = new TrackedState(runStateMachine, "DRAFT", (_f, to) => seen.push(to));
    for (const next of [
      "COMPILED",
      "VALIDATED",
      "EXECUTION_PLAN_GENERATED",
      "PENDING_APPROVAL",
      "APPROVED",
      "RUNNING",
      "COMPLETED",
    ] as const) {
      s.to(next);
    }
    expect(seen).toHaveLength(7);
    expect(s.isTerminal()).toBe(true);
  });

  it("supports the autonomous discovery-led lifecycle without skipping states", () => {
    const s = new TrackedState(runStateMachine, "DRAFT");
    for (const next of [
      "DISCOVERY_PLANNED",
      "DISCOVERY_RUNNING",
      "DISCOVERY_COMPLETED",
      "WEBSITE_PROFILE_GENERATED",
      "TEST_PLAN_GENERATED",
      "EXECUTION_PLAN_GENERATED",
      "PENDING_APPROVAL",
      "APPROVED",
      "RUNNING",
      "COMPLETED",
    ] as const)
      s.to(next);
    expect(s.isTerminal()).toBe(true);
    for (const [from, to] of [
      ["DISCOVERY_PLANNED", "DISCOVERY_COMPLETED"],
      ["DISCOVERY_RUNNING", "TEST_PLAN_GENERATED"],
      ["DISCOVERY_RUNNING", "PENDING_APPROVAL"],
      ["DISCOVERY_COMPLETED", "EXECUTION_PLAN_GENERATED"],
      ["TEST_PLAN_GENERATED", "PENDING_APPROVAL"],
      ["WEBSITE_PROFILE_GENERATED", "APPROVED"],
    ] as const)
      expect(runStateMachine.canTransition(from, to)).toBe(false);
  });

  it("only APPROVED can move to RUNNING", () => {
    for (const from of runStateMachine.states) {
      expect(runStateMachine.canTransition(from, "RUNNING")).toBe(from === "APPROVED");
    }
  });

  it("cannot skip approval or leave terminal states", () => {
    expect(() => runStateMachine.assertTransition("PENDING_APPROVAL", "RUNNING")).toThrow(
      InvalidTransitionError,
    );
    expect(() => runStateMachine.assertTransition("EXECUTION_PLAN_GENERATED", "APPROVED")).toThrow(
      InvalidTransitionError,
    );
    expect(runStateMachine.canTransition("PENDING_APPROVAL", "CANCELLED")).toBe(true);
    for (const t of ["COMPLETED", "FAILED", "CANCELLED"] as const)
      expect(runStateMachine.allowedFrom(t)).toHaveLength(0);
  });
});

describe("work packet state machine", () => {
  it("supports the checkpoint -> handoff -> resume path", () => {
    const s = new TrackedState(workPacketStateMachine, "PENDING");
    for (const next of [
      "QUEUED",
      "RUNNING",
      "CHECKPOINTING",
      "HANDOFF_PENDING",
      "RESUMING",
      "RUNNING",
      "COMPLETED",
    ] as const)
      s.to(next);
    expect(s.state).toBe("COMPLETED");
  });

  it("rejects invalid transitions", () => {
    expect(workPacketStateMachine.canTransition("PENDING", "RUNNING")).toBe(false);
    expect(workPacketStateMachine.canTransition("HANDOFF_PENDING", "RUNNING")).toBe(false);
    expect(workPacketStateMachine.canTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(workPacketStateMachine.terminal).toEqual(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"]);
  });
});

describe("agent instance state machine", () => {
  it("allows warning -> checkpoint -> terminate -> replaced", () => {
    const s = new TrackedState(agentInstanceStateMachine, "CREATED");
    for (const next of [
      "STARTING",
      "ACTIVE",
      "CONTEXT_WARNING",
      "CHECKPOINTING",
      "TERMINATED",
      "REPLACED",
    ] as const)
      s.to(next);
    expect(s.isTerminal()).toBe(true);
  });

  it("a terminated agent can never become active again", () => {
    expect(agentInstanceStateMachine.canTransition("TERMINATED", "ACTIVE")).toBe(false);
    expect(agentInstanceStateMachine.canTransition("REPLACED", "ACTIVE")).toBe(false);
  });
});

describe("handoff state machine", () => {
  it("is strictly linear", () => {
    const order = [
      "NOT_REQUIRED",
      "REQUIRED",
      "WRITING",
      "VALIDATED",
      "PERSISTED",
      "CONSUMED",
      "COMPLETED",
    ] as const;
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(handoffStateMachine.canTransition(order[i]!, order[j]!)).toBe(j === i + 1);
      }
    }
  });
});
