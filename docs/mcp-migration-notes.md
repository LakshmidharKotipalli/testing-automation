# MCP migration evidence

## Baseline — 2026-09-30

Reproduced before changing execution code, on Node 22.17.0, pnpm 10.33.0,
Playwright 1.56.1 / Chromium 141.0.7390.37 (1194), macOS arm64.
The initial frozen install failed because browser-tools declared axe-core but the
lockfile omitted it. `pnpm install --no-frozen-lockfile` reconciled the lockfile.
Baseline unit suite: 19 files, 186 tests passed.

Both runs used the existing preview -> approve --yes -> run --approved-plan flow.
Only BROWSERSWARM_TARGET_URL differed; plans and runtime code were unchanged.

| Run                                     | Result                                                       | Evidence directory             |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| login-validation, http://127.0.0.1:4173 | 3/3 packets passed; 23 actions/checkpoints; zero model calls | artifacts/baseline-fixture/run |
| icatusa-demo, https://demo.icatusa.org  | 3 passed, 1 failed; 14 actions; one finding                  | artifacts/baseline-icatusa/run |

The icatusa failure was `home-health-functional-desktop`, step 1,
`assert_no_console_errors`: **console errors present**. The console reports:

> Refused to load the script 'https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495' because it violates the following Content Security Policy directive: "script-src 'self' https://accounts.google.com/gsi/client 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='".

All four packet network.json files recorded that GET script request with failure
`csp`. All four `blocked` arrays from installDomainGuard were empty. The passing
home-loads packet executed inspect_network_failures and captured this same request.
The failing health packet stopped before assert_no_network_failures; its failure
capture nevertheless preserved console.json and network.json.

Exact failure evidence (relative to artifacts/baseline-icatusa/run):

- packets/home-health-functional-desktop/screenshots/step-001-failure.png
- packets/home-health-functional-desktop/dom/step-001-failure.html
- packets/home-health-functional-desktop/console.json
- packets/home-health-functional-desktop/network.json
- packets/home-health-functional-desktop/trace/trace.zip
- reports/report.json and events/events.ndjson

Source inspection confirms context-wide routing, blocked service workers,
headless Chromium, en-US locale and UTC timezone. These settings did not prevent
the home-page and responsive checks from passing in this run. The observed failure
is a site CSP violation, not evidence of domain-guard abortion or a bot challenge.
No claim is made that the external site will behave identically in future runs.

## Safety and compatibility

Never add stealth, fingerprint spoofing or challenge solving. Detected challenges
must stop as BLOCKED with reason bot_protection_challenge and evidence. For owned
sites, arrange test-traffic allowlisting with the site owner.

Playwright MCP 0.0.68 CLI help was inspected: it supports --save-trace, --init-page,
--isolated, --storage-state, --output-dir and --config. Its allowed-origins option
explicitly does not enforce redirect scope. 0.0.83 was also inspected but removed
--save-trace. OpenCode installed here is 2.0.19; run --help confirms --standalone,
--model, --agent and --format json. Stdin/events and configuration isolation still
require integration validation.

Phase 2 starts only after the Phase 1 acceptance gate passes. Subsequent sections
will record implementation checks and any unverified capabilities.

## Phase 1 implementation status (2026-09-30)

Browser execution is now model -> guarded gateway -> Playwright MCP 0.0.68 -> browser.
Each packet owns one MCP server, a private artifact directory and isolated state.
Gates at commit b92efa2: lint, typecheck, test (225 passing) and build all pass.

Observed facts:

- MCP 0.0.68 writes traces as `.trace` files under `traces/`, not a ZIP.
- Scripted steps without a gateway equivalent (for example axe checks) return BLOCKED.
- Cross-domain redirect blocking, challenge pages, read-only POST blocking and
  cancellation were verified against real MCP sessions.

Known limitations and unverified items:

- **OpenCode real execution is unavailable.** The installed CLI (2.0.19) exposes
  `/api/config` as source descriptors, not the effective merged configuration. The
  preflight therefore fails closed before any packet browser starts. Effective
  permission, tool and config isolation are unverified; stdin delivery and JSON
  event usage parsing are covered only by fake-process tests.
- OpenRouter is covered by mock HTTP tests only; no live provider call was made.
- Phase 2 (discovery migration, browser project matrix, guarded replay, verifier
  packets) has not started. Discovery still uses the legacy direct-Playwright path.

## Phase 2 implementation status (2026-09-30)

- **Discovery** now runs through the same packet-owned MCP session (`readOnly: true`) and a `DiscoveryBrowser`
  gateway with a tool allowlist (navigate, snapshot, click, type, screenshot, console, network). Writes are
  refused inside the MCP server, including non-GET/HEAD requests, and blocked requests keep their `external`
  / `non-read-method` kind. Verified against the fixture site (no non-GET request reached the server) and a
  local server with an off-scope redirect and a POST form.
- **Profiles are derived from accessibility snapshots plus network evidence.** Not available in this mode and
  recorded as limitations: axe-core scans, viewport overflow measurement, form methods/actions/field names,
  document language, meta descriptions, collapsed `aria-expanded` state (so collapsed accordions are not toggled;
  tabs, expanded disclosure buttons and search landmarks are). Search is exercised by typing a word already on the
  page into a search landmark and submitting; the request guard only lets GET through. Popup, dialog and
  download events are not reported as separate blocked-request kinds.
- **A detected challenge ends discovery as `blocked` with `bot_protection_challenge`**; site-owner allowlisting of
  test traffic is the remedy. No bypass exists.
- **Browser projects, verifier packets and guarded replay** are implemented as described in
  `test-plan-format.md`. Chrome (as opposed to Chromium) projects are covered by plan/hash tests; the real-browser
  matrix test uses two Chromium projects because Chrome was not assumed to be installed.
- **Playwright removal**: `browser-tools`, the root `playwright` dependency and the CI `playwright install` step
  are gone. The only Playwright is the one bundled by `@playwright/mcp@0.0.68`; CI installs its matching Chromium.
  The legacy unit of `axe-core` went with `browser-tools`.
- **Still unverified**: OpenCode real execution (see Phase 1 limitation); live OpenRouter calls; Chrome channel on a
  machine with Chrome; the icatusa site was not re-run against the migrated discovery.
