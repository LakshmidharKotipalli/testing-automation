# Agent authoring

Agents plug into the orchestrator through small, typed contracts. An agent never touches Playwright,
storage or the policy engine directly.

## AgentHost (provided by the orchestrator)

```ts
interface AgentHost {
  packet: WorkPacket; // immutable approved packet
  signal: AbortSignal; // cancellation
  actionsUsed(): number; // packet-level action budget
  deadlineReached(): boolean; // packet timeout
  isStepRisky(index: number): boolean;
  executeStep(
    index: number,
    agent: AgentInstanceHandle,
  ): Promise<"passed" | "failed" | "blocked" | "skipped">;
  checkpoint(reason: CheckpointReason, agent: AgentInstanceHandle, nextIndex: number): Promise<void>;
  emit(type: AgentEventType, agent: AgentInstanceHandle, data: Record<string, unknown>): void;
}
```

`executeStep` performs the runtime policy check, the typed Playwright action, ledger and evidence
persistence, and finding creation for exactly one approved step.

## Rules for any agent

1. Execute only the packet's approved steps, in order. Never add steps or scenarios.
2. Evaluate the `ContextLifecycleManager` between steps only; never interrupt an action in flight.
3. On a rotation decision, return `rotation_required`; the orchestrator writes the checkpoint and handoff.
4. Record concise `actionIntent` strings, never private reasoning.
5. Any LLM proposal must go through `checkLlmProposal()` and may only change the locator of the approved step.
6. Stop on the first failed or blocked step, budget exhaustion, cancellation or a policy block.

## Replacement agents

Implement `ReplacementAgentFactory` (`packages/handoff/src/resume.ts`). The orchestrator calls it only after
`replacementPreflight()` succeeds, passing the validated checkpoint, handoff and a bounded `ResumeContext`
built by `buildResumeContext()`. The factory must create a new agent instance id, start a fresh model
session, and never reuse the exhausted context or transcript.
