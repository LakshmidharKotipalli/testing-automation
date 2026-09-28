# Subagents

Subagents are scoped executors of approved work packets. Each receives the immutable packet (exact steps,
expected outcome, viewport, browser configuration, model, safety/LLM/context policies, budgets), an isolated
BrowserContext and an isolated artifact directory. They do not independently invent coverage.

## Roles

| Role                | Scope                                                                                                                     | Milestone 1 behavior                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `functional`        | Execute the user's exact steps and assertions.                                                                            | Full.                                                                                                                       |
| `forms`             | Approved form validations; never submits destructive forms without approved risk policy.                                  | Executes approved steps deterministically.                                                                                  |
| `accessibility`     | Approved axe-core and keyboard/semantic checks on approved routes.                                                        | Executes approved steps; `run_accessibility_scan` (axe-core) and `inspect_accessibility_tree` available.                    |
| `responsive`        | Approved scenarios at approved viewports; overflow/layout evidence.                                                       | Executes approved steps; `assert_no_horizontal_overflow` available.                                                         |
| `visual`            | Approved screenshot checkpoints; LLM visual review only if enabled.                                                       | Executes approved steps and screenshots.                                                                                    |
| `performance-smoke` | Passive checks only (navigation timing, observable resource failures).                                                    | Executes approved steps.                                                                                                    |
| `security-smoke`    | Only with `safety.allowSecuritySmoke`; passive client-side observations. No exploitation, fuzzing, scanning or bypassing. | Rejected at validation unless allowed.                                                                                      |
| `verifier`          | Reproduces approved-scope findings in an isolated context and marks them confirmed, likely, unverified or rejected.       | Assigned by the framework in Milestone 4; findings at or above `verifySeverityAtOrAbove` are marked verification `pending`. |

### Roles selected by the autonomous planner

Only when discovery evidence justifies them (see [autonomous-mode.md](autonomous-mode.md)): `navigation`,
`content`, `table-data`, `dashboard`, `search-filter`, `forms-read-only`, `functional-ui`,
`ecommerce-browse-only`, `booking-browse-only`, `domain-consistency`, `accessibility`, `responsive`,
`console-network`. All run deterministic, safe-read-only steps built from observed routes and locators.
The Discovery Lead Agent itself is not a test subagent: it is the single read-only packet of the discovery phase.

## Isolation

Every packet has its own BrowserContext, page, storage state, action ledger, trace, screenshots, logs,
checkpoint chain and handoff chain. Rotations release the previous context before a replacement acquires a
new one and occupy the same queue slot, so rotations never exceed the concurrency limit.

## Cancellation

Ctrl+C (or an `AbortSignal`) stops scheduling new packets, lets in-flight actions finish, writes a
`graceful_shutdown` checkpoint for active agents, persists the cancellation reason, and closes contexts.
Resuming requires a new approved execution plan.
