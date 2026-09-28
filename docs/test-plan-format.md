# Test plan format

A test plan is YAML or JSON validated by `TestPlanSchema` (`packages/core/src/schemas/plan.ts`). Unknown
keys are rejected everywhere. The only extension point is `extensions`, whose keys must start with `x-`.

## Top level

| Key                | Required | Default                                                         | Notes                                                                                                                                         |
| ------------------ | -------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | yes      |                                                                 | Must be `1`.                                                                                                                                  |
| `id`, `name`       | yes      |                                                                 |                                                                                                                                               |
| `mode`             | no       | `scripted`                                                      | `scripted` or `llm-assisted`.                                                                                                                 |
| `target`           | yes      |                                                                 | `url`, `allowedDomains` (bare hostnames), `allowSubdomains` (false).                                                                          |
| `browser`          | no       | chromium, headless, en-US, UTC, trace on, screenshot on failure | `engine`, `headless`, `locale`, `timezoneId`, `trace`, `screenshot` (`off`/`only-on-failure`/`on`), `navigationTimeoutMs`, `actionTimeoutMs`. |
| `execution`        | no       | 4 agents, 180 s/agent, 900 s/run, 50 actions                    | `maxConcurrentAgents`, `agentTimeoutMs`, `runTimeoutMs`, `maxActionsPerAgent`, `failFast`.                                                    |
| `models`           | no       | none                                                            | `default` and per-role `overrides` (see [opencode.md](opencode.md)).                                                                          |
| `llm`              | no       | `strategy: disabled`                                            | `strategy`, `maxCallsPerWorkPacket`, `maxTokensPerCall`, `maxRepairAttempts`, `allowedTriggers`.                                              |
| `contextLifecycle` | no       | see [context-lifecycle.md](context-lifecycle.md)                |                                                                                                                                               |
| `safety`           | no       | everything risky blocked                                        | see [safety.md](safety.md).                                                                                                                   |
| `testData`         | no       | `{}`                                                            | `key: "value"` or `key: { value \| fromEnv, secret, category }`. `{{runId}}` is substituted at run time.                                      |
| `viewports`        | no       | `desktop: 1440x900`                                             | Named sizes referenced by scenarios.                                                                                                          |
| `scenarios`        | yes      |                                                                 | At least one.                                                                                                                                 |
| `reporting`        | no       | json + markdown, verify >= high                                 | `outputDir`, `formats`, `verifySeverityAtOrAbove`.                                                                                            |
| `compilation`      | no       |                                                                 | Written by the prompt compiler: assumptions, ambiguities, restrictions, `needsReview`.                                                        |

## Scenario

```yaml
- id: login-invalid-password
  title: Invalid password shows an accessible error
  objective: Verify failed login handling without successful login.
  priority: high # critical | high | medium | low (drives finding severity)
  roles: [functional, accessibility]
  viewports: [desktop, mobile]
  expectedOutcome: User remains on /login and receives an accessible invalid-credentials error.
  steps: [...]
```

Roles: `functional`, `forms`, `accessibility`, `responsive`, `visual`, `performance-smoke`,
`security-smoke` (requires `safety.allowSecuritySmoke`). `verifier` is assigned by the framework only.

## Steps

Every step accepts optional `description` and `timeoutMs`. Values may use `{{testData.key}}` and `{{runId}}`.

| Category    | Actions                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation  | `navigate {url}`, `go_back`, `reload`                                                                                                                                                                                                                                                                                                                                                                |
| Interaction | `click {locator}`, `fill {locator, value}`, `clear {locator}`, `select_option {locator, value}`, `check {locator}`, `uncheck {locator}`, `press_key {key, locator?}`, `scroll {locator? , direction, amount}`, `wait_for {locator?, state, urlContains?}`                                                                                                                                            |
| Assertions  | `assert_visible`, `assert_hidden`, `assert_enabled`, `assert_disabled`, `assert_checked` `{locator}`; `assert_text_contains` / `assert_text_equals {locator, text}`; `assert_url_contains` / `assert_url_equals {value}`; `assert_count {locator, count}`; `assert_response_status {urlContains, status}`; `assert_no_console_errors`; `assert_no_network_failures`; `assert_no_horizontal_overflow` |
| Artifacts   | `screenshot {name, fullPage}`, `snapshot_dom {name, locator?}`, `record_note {note}`                                                                                                                                                                                                                                                                                                                 |
| Quality     | `inspect_console_logs`, `inspect_network_failures`, `run_accessibility_scan` (Milestone 2), `inspect_accessibility_tree` (Milestone 2)                                                                                                                                                                                                                                                               |

There is deliberately no action that evaluates arbitrary JavaScript.

## Locators

Resolution precedence (first present wins): `role` (+ `name`), `label`, `placeholder`, `testId`, `text`,
`css`. `exact` makes name/label/text matching exact; `nth` selects a match. CSS-only locators produce a
validation warning.

```yaml
locator: { role: button, name: Sign in }
locator: { label: Email }
locator: { testId: plan-pro }
```

## Natural-language prompt grammar

The deterministic compiler understands this Markdown structure:

```markdown
# Plan name

Allowed domains: staging.example.com

## Test data

- validEmail: qa+{{runId}}@example.test
- password (secret): ...

## Scenario: Title

Objective: ...
Priority: high
Roles: functional, accessibility
Viewports: desktop, mobile (known: desktop, laptop, tablet, mobile)
Expected: ...
Steps:

1. Navigate to /login
2. Verify heading "Sign in" is visible
3. Fill "Email" field with {{testData.validEmail}}
4. Click button "Sign in"
5. Verify URL contains /login
6. Verify alert contains "Invalid email or password"
7. Select "yearly" in "Billing period" dropdown
8. Check "I accept the terms" checkbox
9. Press Enter
10. Wait for "Welcome"
11. Verify test id "plan-pro" contains "$20"
12. Verify there are no console errors / no network failures / no horizontal overflow
13. Take screenshot invalid-password-error
14. Note: free text

## Restrictions

- Do not create accounts.
```

Lines the compiler does not understand are reported as ambiguities and excluded; the plan is then marked
`needsReview`. Requests to "allow purchases" and similar are recorded but never turn on risky permissions.
