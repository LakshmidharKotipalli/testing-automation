# Execution plan format

`browserswarm preview --write execution-plan.json` writes an `ExecutionPlan`
(`packages/core/src/schemas/execution.ts`). It is generated deterministically from a valid test plan and is
the exact object the user approves.

## Expansion

Work packets are the cross-product of scenario x role x viewport x browser project (one engine per plan
in v1). Nothing beyond the plan is created. Packet ids are stable: `{scenarioId}-{role}-{viewportName}`.
Example: roles `functional, accessibility` and viewports `desktop, mobile` produce exactly four packets.

## Fields

| Field                                                       | Meaning                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionPlanId`, `runId`, `createdAt`                     | Identity. The run id is fixed at preview time.                                                                                                                      |
| `planId`, `planName`, `planHash`                            | The test plan this was generated from.                                                                                                                              |
| `target`                                                    | URL, allowed domains, subdomain flag.                                                                                                                               |
| `concurrency`                                               | `maxConcurrentWorkPackets` (= `--parallel` or `execution.maxConcurrentAgents`, capped at packet count), `maxConcurrentBrowserContexts`, `failFast`, `runTimeoutMs`. |
| `models`                                                    | Model per role (`null` = deterministic only).                                                                                                                       |
| `llm`, `contextLifecycle`, `safety`, `browser`, `reporting` | Resolved policies.                                                                                                                                                  |
| `testData`                                                  | Hash-bound test data (literal values or `fromEnv` references). Values are resolved only at run time.                                                                |
| `workPackets[]`                                             | Immutable packets (below).                                                                                                                                          |
| `summary`                                                   | Counts and estimates shown in the review.                                                                                                                           |
| `riskFlags`, `riskPlanHash`, `requiresExplicitRiskApproval` | Risky steps permitted by policy that need typed risk approval.                                                                                                      |
| `limitations`                                               | Capabilities not available in the current milestone, shown before approval.                                                                                         |
| `executionPlanHash`                                         | SHA-256 of everything above.                                                                                                                                        |

## Work packet

`packetId`, `runId`, `planId`, `scenarioId`, `scenarioTitle`, `objective`, `priority`, `role`,
`viewportName`, `viewport`, `browser`, `targetUrl`, `allowedDomains`, `allowSubdomains`, `steps` (exact,
templates unresolved), `expectedOutcome`, `mode` (`deterministic` / `llm-capable`), `model`, `llmPolicy`,
`contextPolicy`, `safety`, `timeoutMs`, `actionBudget`, `llmCallBudget`, `artifactDir`, `planHash`,
`riskFlags`, `requiresExplicitRiskApproval`, `workPacketHash`.

## Estimates

| Estimate                | How                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maximum browser actions | Sum of packet action budgets.                                                                                                                               |
| Maximum LLM calls       | Sum of LLM call budgets of llm-capable packets.                                                                                                             |
| Estimated max tokens    | Max LLM calls x `maxTokensPerCall`.                                                                                                                         |
| Rotations / handoffs    | Per packet `ceil(steps / maxActionsPerAgentInstance) - 1` (at least 1 for llm-capable packets when monitoring is on), capped by `maxHandoffsPerWorkPacket`. |
| Maximum agent instances | Packets + rotations.                                                                                                                                        |
| Checkpoints             | Steps per packet (when checkpointing after every step) + rotations.                                                                                         |
| Runtime                 | Lower bound from waves x longest scenario; upper bound from waves x agent timeout, capped by run timeout.                                                   |

See `examples/login-validation/execution-plan.json` for a complete example (a snapshot generated for the
default `BROWSERSWARM_TARGET_URL` in `.env.example`; with another URL, run `preview` to generate your own).
