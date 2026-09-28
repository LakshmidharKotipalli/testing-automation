# Safety and authorization

**You must have authorization from the owner of the website or application before testing it.**
BrowserSwarm is a functional/quality testing tool. It is not a security scanner or exploitation tool.

## Defaults

| Area                                                                                                                | Default                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation                                                                                                          | Only `target.allowedDomains` (exact hosts; subdomains only with `allowSubdomains: true`). Ports are not part of the scope. External navigation can never be enabled. |
| Account creation, purchases, payments, uploads, downloads, email/SMS, invitations, social posting, password changes | Blocked                                                                                                                                                              |
| Deletion, data modification, irreversible actions                                                                   | Blocked (`destructiveActions: deny`)                                                                                                                                 |
| Successful authentication                                                                                           | Not expected (`allowAuthentication: false`)                                                                                                                          |
| Security smoke role                                                                                                 | Blocked unless `allowSecuritySmoke: true`; passive observations only                                                                                                 |
| Redaction                                                                                                           | Enabled                                                                                                                                                              |
| Findings                                                                                                            | Evidence required (`requireEvidenceForFindings` is always true)                                                                                                      |

Never done, regardless of configuration: solving CAPTCHAs; bypassing authentication, authorization, rate
limits, bot protection or paywalls; active exploitation, payload fuzzing, credential attacks, intrusive
scanning or denial-of-service behavior.

## Autonomous discovery

Autonomous mode's Discovery Lead Agent is read-only by construction: it requires your authorization for the
stated target, aborts every non-GET/HEAD request and every request outside the allowed domains, blocks
downloads/popups/dialogs/file choosers/service workers, never types into fields or submits forms, never
authenticates, and records (never clicks) any control that looks state-changing or whose effect is unknown.
Cookie banners are only dismissed with a reject/necessary-only control. Generated plans contain only
`safe-read-only` scenarios; anything requiring credentials, test data or risk approval is listed separately
and never runs without a separately approved plan and an explicit risk acknowledgement. Details:
[autonomous-mode.md](autonomous-mode.md).

## Where the policy engine runs

1. Plan validation: risky steps not allowed by policy make the plan invalid.
2. Execution-plan generation: allowed risky steps become risk flags requiring typed risk approval.
3. Before every browser action: the step must equal the approved step, the current page must be in scope,
   and any risk must be permitted, approved in the plan and accepted in the approval record.
4. Before every LLM fallback: a proposal may only change the locator of the approved step.
5. Before every handoff: hashes, mission, allowed domains, resume index, secrets and raw storage state are checked.
6. Before every replacement-agent launch: the resume context must match the approved packet and safety policy.

A context-level route guard also aborts every request to a host outside the allowed domains. A step that
triggers a blocked navigation, or leaves the page outside scope, blocks the packet with evidence.

## Risk classification

Risk is classified from the action and the text of the element it acts on (accessible name, label, text,
test id, placeholder, CSS). Examples: `Delete account` -> deletion, `Place order` -> purchase, `Pay now` ->
payment, `Create account` -> account creation, `Send invitation` -> invitation. Classification is
deliberately conservative; a false positive only requires an explicit opt-in.

## Redaction

- Test-data values are resolved only at execution time. Plans, work packets, ledgers and handoffs keep
  `{{testData.key}}` templates.
- Every resolved test-data value is redacted as `[REDACTED:testData.key]` in ledgers, DOM excerpts, console
  and network logs, handoffs, reports and model prompts. Values shorter than 4 characters cannot be matched
  reliably; use longer test values for anything sensitive.
- Bearer tokens and JWT-shaped strings are redacted by pattern; values under sensitive keys (password,
  token, cookie, secret, session, card, ...) are redacted by key.
- Use `fromEnv` for secrets so they never live in plan or approval files:
  `password: { fromEnv: QA_PASSWORD, secret: true }`.
- Storage state (cookies/localStorage) is written only to the packet's `browser-state/` artifact, filtered to
  allowed domains, and is never copied into handoffs, reports or model context.
- Model prompts never include cookies, credentials, raw DOM or unredacted test data.
- The LLM API key from `.env` is passed only to the OpenCode child process and is redacted from every
  artifact, log, report and prompt.
