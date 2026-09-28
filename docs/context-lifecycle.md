# Context lifecycle and agent rotation

An agent instance is disposable. When it approaches its context window, token budget or lifecycle limit,
BrowserSwarm checkpoints its work, writes a handoff document, terminates it and (Milestone 3) continues the
same approved work packet with a replacement instance. An exhausted context is never silently ignored.

## Accounting (`ContextLifecycleManager`)

- **Exact**: when the provider (via OpenCode) reports input/output tokens or a context window, those values win.
  Per-call input already includes the running conversation, so the maximum input seen is used.
- **Estimated**: otherwise prompt and output text are estimated at 3.5 characters per token (deliberately
  conservative), and messages, observations, actions and LLM calls are counted.
- **Context window**: provider-reported, else `ModelRef.contextWindowTokens`, else
  `contextLifecycle.modelContextWindowTokens`, else a small safe default (32,000). Models are never assumed to
  share one size. Utilization is measured against `min(window, maxEstimatedTotalTokensPerAgentInstance)`.

## Triggers (earliest applicable wins, in priority order)

| Trigger                         | Condition                                                   | Checkpoint reason    |
| ------------------------------- | ----------------------------------------------------------- | -------------------- |
| manual                          | rotation requested (CLI/dashboard)                          | `manual`             |
| context_hard_limit              | utilization >= `contextHardStopThresholdPercent` (85)       | `context_hard_limit` |
| input/output/total token budget | per-instance estimated budgets reached                      | `context_hard_limit` |
| message_limit                   | `maxMessagesPerAgentInstance`                               | `context_hard_limit` |
| action_limit                    | `maxActionsPerAgentInstance` (works without any token data) | `action_limit`       |
| duration_limit                  | `maxDurationMsPerAgentInstance`                             | `duration_limit`     |
| fallback_limit / model_error    | repeated fallback failures or model errors                  | `model_error`        |
| context_warning (soft)          | utilization >= `contextWarningThresholdPercent` (75)        | `context_warning`    |

Rules:

- Limits are evaluated **between** actions. A Playwright action in flight is never interrupted (`defer`).
- The soft warning emits `agent.context.warning` once and checkpoints proactively (when
  `checkpointOnContextWarning`), then execution continues.
- Before a risky step, a checkpoint is written first (`checkpointBeforeRiskyAction`), then normal policy checks apply.
- After a hard trigger, the old agent makes no further model calls.
- If a checkpoint or handoff cannot be persisted, the packet is BLOCKED with evidence; no replacement starts.
- `maxHandoffsPerWorkPacket` caps rotations; exceeding it blocks the packet with `handoff_limit_exceeded`.

## Policy fields

```yaml
contextLifecycle:
  enabled: true
  modelContextWindowTokens: 128000 # optional fallback
  contextWarningThresholdPercent: 75
  contextHardStopThresholdPercent: 85
  maxMessagesPerAgentInstance: 20
  maxEstimatedInputTokensPerAgentInstance: 20000
  maxEstimatedOutputTokensPerAgentInstance: 4000
  maxEstimatedTotalTokensPerAgentInstance: 24000
  maxActionsPerAgentInstance: 18
  maxDurationMsPerAgentInstance: 600000
  maxConsecutiveFallbackCalls: 2
  checkpointBeforeRiskyAction: true
  checkpointAfterEveryStep: true
  checkpointOnContextWarning: true
  restoreBrowserSession: storage-state # or none
  allowResumeCurrentUrl: true
  maxHandoffsPerWorkPacket: 3
  includeRecentActionCount: 8
  includeRecentObservationCount: 8
  includeCompletedStepDetail: summary # or full
  handoffMaxTokensEstimate: 1800
  includeScreenshotsInHandoff: false # must be false
  includeRawDomInHandoff: false # must be false
```

Choose conservative thresholds: rotation should happen well before a model fails from context exhaustion.

## Rotation sequence

1. Trigger detected between steps; `agent.context.limit_reached` emitted.
2. Packet `RUNNING -> CHECKPOINTING`; agent `-> CHECKPOINTING`; `packet.handoff.required`.
3. Checkpoint persisted (hash + sidecar) with sanitized storage state.
4. Handoff written deterministically, validated (schema, integrity, secrets, raw storage state, transcript
   content) and policy-checked, then persisted (JSON, Markdown, `.sha256`).
5. Agent `-> TERMINATED`; packet `-> HANDOFF_PENDING`.
6. Replacement preflight: packet not terminal, handoff cap, work-packet hash, checkpoint and handoff hashes,
   plan hash binding, handoff/checkpoint agreement.
7. Milestone 3: `ReplacementAgentFactory` creates a new instance (new id, fresh model session, fresh
   BrowserContext), builds a bounded `ResumeContext`, restores sanitized storage state or deterministically
   replays the minimal approved state-building steps, validates the page state, and resumes at
   `resumeFromStepIndex`. Milestone 1 blocks the packet at this point with `replacement_agent_unavailable`.

## Scripted packets

Scripted agents make no LLM calls, but the action and duration limits still apply, so planned rotation can
be tested (and used) without any model. See `examples/long-running-agent-handoff`.
