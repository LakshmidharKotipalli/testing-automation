# Approval flow

BrowserSwarm never starts a browser, Playwright context, execution agent or execution model before the user
approves the exact execution plan.

## Steps

1. **Plan**: `browserswarm plan` compiles a prompt (or normalizes YAML/JSON) into an editable `TestPlan`.
2. **Validate**: `browserswarm validate` checks schema, references, budgets and the safety policy.
3. **Preview**: `browserswarm preview --write execution-plan.json` expands the plan into work packets,
   computes estimates and hashes, and prints the review. The run is now `PENDING_APPROVAL`.
4. **Decide**: `browserswarm approve` prints the review again and asks: `approve / reject / export / edit`.
5. **Run**: `browserswarm run --approved-plan approved-execution-plan.json` verifies everything, then runs.

## What approval binds

The `ApprovalRecord` stores `planHash`, `executionPlanHash`, `riskPlanHash`, the decision, mode
(`interactive` or `noninteractive`), operator, time and its own `recordHash`. The approved file wraps the
execution plan and the record with an `approvedPlanHash`. At run start `verifyApprovedPlan()` recomputes:

- every work-packet hash and its binding to the plan hash and run id,
- the execution plan hash and the risk plan hash,
- the approval record hash, decision and binding,
- the approved plan hash,
- risk acceptance when the plan contains risky steps,
- when `--plan` is also given, that the current plan still hashes to the approved `planHash`.

Any mismatch raises an error before anything is launched.

## What invalidates approval

Any change to target URL, allowed domains, scenarios, steps, expectations, test data, roles, viewports,
models, concurrency (`--parallel`), browser configuration, or the safety, LLM, context or handoff policy
changes the plan hash or the execution plan hash, so the old approval no longer verifies. Generate a new
execution plan and approve again.

## Decisions

| Decision  | Effect                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `approve` | Writes `approval-record.json` and the immutable `approved-execution-plan.json`. The interactive `run` shortcut then starts the run. |
| `reject`  | Writes `approval-rejection.json`; exit code 4; no browser activity.                                                                 |
| `export`  | Writes `compiled-plan.yaml` and `execution-plan.json`; nothing runs.                                                                |
| `edit`    | Prints instructions; a fresh execution plan and approval are required.                                                              |

End of input (e.g. a closed stdin) counts as `reject`.

## Noninteractive approval (CI)

`--yes` prints the full review and records a `noninteractive` approval. It refuses plans with risky steps
unless `--accept-risk --risk-plan-hash <hash>` is given with the exact risk plan hash from the review.

## Risk approval

Risky steps require all of:

1. the category enabled in `safety` (e.g. `destructiveActions: allow-with-approval`),
2. approval of the execution plan,
3. a separate typed risk approval: interactively, typing `accept-risk <first 12 hex chars of the risk plan hash>`;
   in CI, `--accept-risk --risk-plan-hash <hash>`.

At run time the policy engine still checks each risky step against the packet's approved risk flags and the
record's `riskAccepted` flag.

## Exit codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | Success (all packets passed)                                      |
| 1    | Run completed with failed/blocked packets, or an unexpected error |
| 2    | Invalid plan or arguments                                         |
| 3    | Approval, integrity or risk-approval error                        |
| 4    | Plan rejected                                                     |
| 130  | Run cancelled                                                     |
