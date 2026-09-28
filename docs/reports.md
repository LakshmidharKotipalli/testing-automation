# Reports and artifacts

## Artifact hierarchy

```
artifacts/{runId}/
  metadata/     original-prompt.md(.sha256), compiled-plan.yaml(.sha256), execution-plan.json(.sha256),
                approval-record.json, approved-execution-plan.json, run.json
  events/       events.ndjson
  packets/{workPacketId}/
                work-packet.json, packet-state.json, actions.ndjson, step-results.json, findings.json,
                console.json, network.json, artifact-manifest.json, dom/, screenshots/, trace/trace.zip,
                browser-state/storage-state.json,
                checkpoints/checkpoint-NNNN.json + .sha256,
                handoffs/handoff-NNNN.json + .md + .sha256,
                agent-instances/{agentInstanceId}/instance.json, context-usage.json, resume-context-manifest.json
  verification/{verificationPacketId}/   (Milestone 4)
  reports/      report.json, report.md   (report.html and junit.xml in Milestone 2)
```

Checkpoints, handoffs, approval records, plan/execution hashes, packet state and run state are written
atomically. `storage-state.json` is filtered to the allowed domains and never copied into handoffs or reports.

## Action ledger (`actions.ndjson`)

One line per action: packet id, agent instance id, action number, step index, action, concise action
intent, timestamp, sanitized arguments (test data stays as `{{testData.*}}`), locator, URL, duration,
status (`passed`/`failed`/`skipped`/`blocked`), evidence paths, `llmInvolved`, error, skip reason.

## Events (`events.ndjson`)

Ordered, sequence-numbered events including `run.approved`, `run.started`, `packet.queued`,
`packet.started`, `packet.step.started/completed/failed/skipped`, `packet.checkpoint.created`,
`packet.handoff.required/created/validated`, `agent.context.warning`, `agent.context.limit_reached`,
`agent.checkpointing`, `agent.terminated`, `policy.blocked`, `finding.created`, `packet.completed/failed/blocked`,
`run.completed/failed/cancelled` and every state-machine transition.

## `report.json` / `report.md`

- **Run overview**: run id, target, allowed domains, state, hashes, approval mode/operator/time, models
  configured and invoked, browser/viewport matrix, concurrency, safety and context policies.
- **Execution overview**: scenario, packet and agent-instance counts; passed/failed/blocked/error/cancelled
  packets; deterministic vs LLM-assisted operations; LLM calls and tokens; context warnings; checkpoints;
  handoffs; replacement agents; resumed packets; packets blocked by checkpoint/handoff failure or handoff limit;
  maximum observed concurrency.
- **Per packet**: role, viewport, model, outcome and reason, agent-instance sequence with termination
  reasons, rotation reasons, resume outcome, step results, checkpoints, handoffs (previous/replacement agent,
  trigger, progress, remaining steps, restoration outcome, integrity) and artifact directory.
- **Findings**: title, severity, confidence, status, origin (deterministic / llm-assisted / verifier),
  probabilistic label, scenario, role, viewport, originating agent, whether it persisted through a handoff,
  expected vs actual, reproduction steps, evidence and verification status.
- **Limitations**: milestone limitations, skipped and blocked steps, context-lifecycle interruptions, and
  routes/roles/viewports not tested by design.

All AI-generated claims are labeled probabilistic unless independently confirmed. Deterministic assertion
failures are labeled evidence-backed.

`browserswarm report --run <dir>` re-renders `report.md` from `report.json`.
