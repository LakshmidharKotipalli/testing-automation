# Autonomous discovery-led mode

BrowserSwarm has two run modes.

| Mode              | When                                                                                           | Scope comes from                                  |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `instruction-led` | `--plan`, or a prompt with explicit scenarios, steps, expected outcomes, routes or "only test" | Your instructions (never broadened)               |
| `autonomous`      | Only a target URL, or a broad request such as "Test this website" / "Explore and test ..."     | Evidence observed by one read-only discovery pass |

`--mode instruction-led | autonomous` always overrides the automatic choice. An unrecognized prompt that is not
a broad request stays instruction-led, so your words, not discovery, define the scope.

```bash
# URL only -> autonomous
pnpm browserswarm run --url https://staging.example.com
# broad request -> autonomous
pnpm browserswarm run --url https://staging.example.com --prompt-text "Figure out this website and test it."
# explicit instructions -> instruction-led (unchanged behavior)
pnpm browserswarm run --url https://staging.example.com --prompt ./specific-test-request.md
# discovery + plan + review only; nothing is executed
pnpm browserswarm discover --url https://staging.example.com
```

## Lifecycle

```
DRAFT
-> DISCOVERY_PLANNED        preflight shown, operator authorization recorded (hash-bound)
-> DISCOVERY_RUNNING        exactly one Discovery Lead Agent, one isolated browser context, read-only
-> DISCOVERY_COMPLETED
-> WEBSITE_PROFILE_GENERATED
-> TEST_PLAN_GENERATED      AutonomousTestPlanGenerator (evidence-based, safe-read-only scenarios)
-> EXECUTION_PLAN_GENERATED exact, hashed work packets
-> PENDING_APPROVAL         Autonomous Discovery Review
-> APPROVED -> RUNNING -> COMPLETED | FAILED | CANCELLED
```

Work phases: `discovery`, `planning`, `approval`, `execution`, `verification`, `reporting`. No test
subagent starts before approval; `RUNNING` is reachable only from `APPROVED`. A `failed` or `blocked`
discovery stops before plan generation and reports why.

## Authorization

Discovery opens a browser, so it needs your authorization first. The preflight lists the target, allowed
domains (default: the target host), limits and guarantees; answer `yes`, or pass `--confirm-authorized` in CI.
`--yes` alone never authorizes discovery. The authorization record is bound to the discovery packet hash and
stored at `discovery/discovery-authorization.json`. `robots.txt` is never treated as authorization.

## The Discovery Lead Agent

One bounded work packet (`discovery/discovery-packet.json`), deterministic inspection first:

- Breadth-first crawl of allowed-domain routes (normalized path + query, at most 3 query variants per path).
- A single fixed in-page extraction: title, headings, landmarks, links (targets read, not opened), buttons,
  forms (field types and labels only, never values), tables, tabs, accordions, pagination, cards, media,
  visible error/empty states.
- Safe interactions only: internal links, tabs/disclosures/accordions, read-only pagination, read-only GET
  search/filter URLs (the search term is a word already on the page), scrolling, viewport changes, and a
  cookie banner's reject/necessary-only control.
- axe-core scan per route, console errors, failed requests, horizontal-overflow measurement per viewport,
  screenshots (budgeted), optional trace.

Enforced by construction, not just by classification:

- Every non-GET/HEAD request is aborted in the browser (form posts, fetch writes, beacons, preflights).
- Requests outside the allowed domains are aborted; external links are recorded, never followed.
- Downloads, file choosers, popups and dialogs are blocked or dismissed; service workers are blocked.
- Controls whose label, URL or context indicates create/add/save/submit/send/pay/purchase/order/book/reserve/
  publish/post/delete/remove/cancel/confirm/invite/upload/download/start/stop/deploy/execute/logout (and any
  control whose effect cannot be determined) are recorded as restricted candidates and never clicked.
- No login, registration, password reset, CAPTCHA solving, fuzzing, scanning, injection or load.

Default limits (override with `--discovery-config <yaml>` under `discovery:`):

```yaml
discovery:
  maxRoutesDiscovered: 100
  maxRoutesVisited: 75
  maxNavigationDepth: 5
  maxNavigations: 150
  maxSafeInteractions: 80
  maxDurationMs: 900000
  maxScreenshots: 100
  maxUniqueFormsInventoried: 50
  maxUniqueInteractiveElementsPerRoute: 200
  maxExternalLinksRecorded: 100
  stopWhenNoNewRoutesAfter: 15
  allowSearchAndFilters: true
  allowNonPersistentTabsAndAccordions: true
  allowReadOnlyPagination: true
  allowCookieBannerDismissal: true
  viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }
  runAccessibilityScan: true
browser: { trace: true }
contextLifecycle: { maxActionsPerAgentInstance: 200 }
# discoveryModel: { provider: opencode-cli, model: provider/fast-model }   # optional classification help
```

Discovery stops cleanly on any limit, on convergence (no new routes after N visits), when the target is
unreachable, at a policy boundary, when the context/handoff budget is exhausted, on Ctrl+C, or on an
unrecoverable error; the stop reason is recorded. The context lifecycle applies to the discovery agent too:
on rotation it writes a hash-verified checkpoint (frontier, visited routes, counters) and handoff, and a
replacement instance continues in a fresh context without revisiting routes.

Classification is deterministic keyword/structure scoring. An optional model (`discoveryModel`) may refine
it using only redacted structure (routes, titles, headings, navigation labels, evidence ids); its answer
must cite existing evidence ids or it is discarded. No transcript is stored.

## Website Understanding Profile

`discovery/website-understanding-profile.json` (Zod: `WebsiteUnderstandingProfileSchema`) holds:
classification (category or `unknown`, confidence, evidence), business purpose, access model (public
routes, auth boundaries, observed roles), route graph, domain model (entities, list-detail relationships,
terminology, observed rules and rules needing verification), user journeys, UI inventory (forms, tables,
search/filters, tabs, pagination, uploads, downloads, side-effecting controls), quality surface, risk
classification, recommended strategy, limits, stats, limitations, assumptions and `profileHash`.

Facts (observed routes, controls, tables, signals) are separated from inferences (category, purpose,
entities, roles, journeys), which carry confidence and are listed under `assumptions`. Every recommended role
and scenario must reference evidence, and recommended scenarios may only use discovered routes (schema-enforced).

Outputs in `discovery/`: `website-understanding-profile.{json,md}`, `discovery-report.{json,md,html}`,
`route-map.{json,mmd}`, `route-inventory.json`, `ui-inventory.json`, `domain-model.json`,
`journey-inventory.json`, `risk-inventory.json`, `quality-surface.json`, `events.ndjson`, and under
`discovery/lead/`: screenshots, a11y results, trace, `actions.ndjson`, console/network logs, blocked requests,
checkpoints, handoffs and the artifact manifest.

## Autonomous test planning

`AutonomousTestPlanGenerator` builds a normal, editable `TestPlan` and its `ExecutionPlan`. Roles are chosen
only when evidence justifies them:

| Role                    | Scheduled when                                                                |
| ----------------------- | ----------------------------------------------------------------------------- |
| `navigation`            | internal links from the entry page to discovered public routes                |
| `content`               | content-like site with headings on public routes                              |
| `table-data`            | tables with column headers                                                    |
| `dashboard`             | pages with multiple data regions                                              |
| `search-filter`         | a read-only GET search/filter was exercised and returned results              |
| `forms-read-only`       | forms exist (render and label checks only; never filled or submitted)         |
| `functional-ui`         | tabs/disclosures/pagination were exercised safely                             |
| `ecommerce-browse-only` | e-commerce/marketplace list -> detail browsing (no cart/checkout)             |
| `booking-browse-only`   | booking list -> detail browsing (no reservations)                             |
| `domain-consistency`    | the same labelled value is visible on several routes                          |
| `accessibility`         | public routes (axe-core WCAG 2 A/AA; flagged routes first)                    |
| `responsive`            | a mobile viewport was inspected (overflow + screenshot; flagged routes first) |
| `console-network`       | console errors/failed requests were seen, or key public routes need a smoke   |

Every scenario carries `source` (`discovery-route`, `discovery-journey`, `discovery-quality-signal`,
`discovery-domain-rule`), `safetyClass` (always `safe-read-only` for executable scenarios), evidence, routes,
preconditions, exact deterministic steps, expected outcome, priority, `executableWithoutLlm` and a rationale.
Anything needing credentials, test data or risk approval is listed under `deferredScenarios` (never
executed); uploads, downloads, logout, external sites, unknown-effect controls, active security testing,
visual regression without a baseline and load testing are listed under `excludedScenarios`. Every generated
step is re-checked by the plan validator and risk classifier; a flagged scenario is dropped, never "fixed"
by relaxing policy. The generator never invents routes, test data, credentials or business rules.

## Review and approval

The **BrowserSwarm Autonomous Discovery Review** shows what the site appears to be, discovery limits,
safe and restricted areas, the quality surface, selected roles with rationale, budgets, every proposed
scenario, deferred and excluded items, scope conflicts, and three integrity hashes (discovery profile, test
plan, execution plan). Choose:

- `approve-safe-plan`: persists the approval record (bound to the plan, execution plan and profile hashes),
  writes the immutable approved plan, and runs exactly the approved packets.
- `export-and-edit`: writes `metadata/autonomous-plan.yaml` and `metadata/execution-plan.json`; nothing runs.
- `reject`: persists the rejection; nothing runs.

### Editing the generated plan

Remove scenarios, routes, roles or categories:

```bash
# at run time
pnpm browserswarm run --url https://staging.example.com --exclude-route /blog --exclude-role responsive
# from a saved profile (no new discovery)
pnpm browserswarm autonomous-plan --profile artifacts/<run>/discovery/website-understanding-profile.json \
  --exclude-category forms --output plans/autonomous-plan.yaml --write plans/execution-plan.json
# or hand-edit the exported YAML, then
pnpm browserswarm preview --plan plans/autonomous-plan.yaml --profile <profile.json> --write plans/execution-plan.json
pnpm browserswarm approve --plan plans/autonomous-plan.yaml --profile <profile.json> --execution-plan plans/execution-plan.json
```

`--profile` verifies the profile hash and rejects discovery-sourced scenarios that use undiscovered routes.
Any edit changes the plan hash, which regenerates the execution plan and requires a fresh approval. Changes to
target, allowed domains, scope, models, safety policy, browser config, context policy, concurrency or packets
all invalidate approval the same way.

## Scope resolution policy

Priority order: (1) explicit user safety restrictions, (2) explicit user scenarios and expected outcomes,
(3) explicit user exclusions, (4) explicit agent/model/concurrency preferences, (5) discovery evidence,
(6) the default safe QA policy. With a specific plan, nothing is added autonomously. If instructions conflict
with the safety policy, safety wins and the conflict is shown in the review. Requested state-changing actions
(login, checkout, submissions, deletion, bookings, uploads) are classified `requires-credentials` or
`requires-risk-approval`, shown separately, and never run without a separately approved plan plus an explicit
risk acknowledgement. The resolution record is stored in the plan (`origin.scopeResolution`) and hashed.
