# Configuration

In Milestone 1 all behavior is configured in the test plan itself, so every setting is part of the
approved, hashed plan. `browserswarm.config.example.yaml` shows the shape of a reusable model profile;
standalone config-file merging arrives with the OpenCode workflow in Milestone 4 (and will also be
hash-bound into the execution plan).

## Central `.env` file

The CLI and the fixture server load `./.env` (or the file named by `BROWSERSWARM_ENV_FILE`) at startup.
Variables already set in the shell or CI take precedence. Copy `.env.example` to start.

Target website precedence: `--url` flag or a plan's own `target.url` > `BROWSERSWARM_TARGET_URL`.
The resolved URL is bound into the plan hash, so changing `.env` requires a fresh preview and approval, and
`run --approved-plan` refuses a plan approved for a different website than the one configured.

## Environment variables

| Variable                           | Purpose                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSERSWARM_TARGET_URL`          | The website under test, used by every plan/prompt without an explicit target and by `pnpm fixture:serve` (port).                            |
| `BROWSERSWARM_ALLOWED_DOMAINS`     | Optional comma-separated allowed domains; default is the target URL's host.                                                                 |
| `BROWSERSWARM_LLM_API_KEY`         | Optional model API key; passed only to the OpenCode process and redacted everywhere.                                                        |
| `BROWSERSWARM_LLM_API_KEY_ENV`     | Variable name the key is exported as for OpenCode (e.g. `ANTHROPIC_API_KEY`).                                                               |
| `BROWSERSWARM_ENV_FILE`            | Load a different env file instead of `./.env`.                                                                                              |
| `BROWSERSWARM_CHROMIUM_EXECUTABLE` | Use a specific Chromium binary (e.g. when Playwright's bundled browser is unavailable).                                                     |
| `BROWSERSWARM_OPERATOR`            | Operator name recorded in approval records (defaults to `$USER`).                                                                           |
| `BROWSERSWARM_LLM_PROVIDER`        | Agentic backend: `openrouter` or `opencode` (`opencode-agent`). Bound into the approved plan; changing it needs a new preview and approval. |
| `BROWSERSWARM_LLM_MODEL`           | Model id for agentic packets (hash-bound).                                                                                                  |
| `BROWSERSWARM_LLM_BASE_URL`        | OpenAI-compatible base URL (default OpenRouter); the `/chat/completions` endpoint is derived from it.                                       |
| `OPENROUTER_API_KEY`               | OpenRouter key; read from the environment only, never written to prompts, plans, child arguments or artifacts.                              |
| `BROWSERSWARM_BROWSER_CHANNEL`     | Chrome/Chromium channel for the Playwright MCP session (hash-bound).                                                                        |
| `PLAYWRIGHT_BROWSERS_PATH`         | Standard Playwright browser location.                                                                                                       |
| test data `fromEnv` variables      | Secrets resolved at run time, e.g. `QA_PASSWORD`.                                                                                           |

## CLI reference

```
browserswarm plan     [--url <url>] --prompt <file> --output <plan.yaml> [--allowed-domain a,b]
browserswarm plan     --plan <plan.yaml|json> --output <plan.yaml>
browserswarm validate --plan <file>
browserswarm preview  --plan <file> [--parallel N] [--write execution-plan.json] [--run-id id]
browserswarm approve  --plan <file> --execution-plan <file> [--output approved.json] [--yes] [--accept-risk --risk-plan-hash <h>] [--operator name]
browserswarm run      --approved-plan <file> [--plan <file>] [--output dir]
browserswarm run      --prompt <file> [--url <url>] | --plan <file>  [--parallel N] [--yes ...] [--output dir]
browserswarm report   --run <dir>
```

Run `pnpm browserswarm <command> --help` for details. Defaults for every plan field are listed in
[test-plan-format.md](test-plan-format.md).
