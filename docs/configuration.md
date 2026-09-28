# Configuration

In Milestone 1 all behavior is configured in the test plan itself, so every setting is part of the
approved, hashed plan. `browserswarm.config.example.yaml` shows the shape of a reusable model profile;
standalone config-file merging arrives with the OpenCode workflow in Milestone 4 (and will also be
hash-bound into the execution plan).

## Environment variables

| Variable                           | Purpose                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `BROWSERSWARM_CHROMIUM_EXECUTABLE` | Use a specific Chromium binary (e.g. when Playwright's bundled browser is unavailable). |
| `BROWSERSWARM_OPERATOR`            | Operator name recorded in approval records (defaults to `$USER`).                       |
| `PLAYWRIGHT_BROWSERS_PATH`         | Standard Playwright browser location.                                                   |
| test data `fromEnv` variables      | Secrets resolved at run time, e.g. `QA_PASSWORD`.                                       |

## CLI reference

```
browserswarm plan     --url <url> --prompt <file> --output <plan.yaml> [--allowed-domain a,b]
browserswarm plan     --plan <plan.yaml|json> --output <plan.yaml>
browserswarm validate --plan <file>
browserswarm preview  --plan <file> [--parallel N] [--write execution-plan.json] [--run-id id]
browserswarm approve  --plan <file> --execution-plan <file> [--output approved.json] [--yes] [--accept-risk --risk-plan-hash <h>] [--operator name]
browserswarm run      --approved-plan <file> [--plan <file>] [--output dir]
browserswarm run      --prompt <file> --url <url> | --plan <file>  [--parallel N] [--yes ...] [--output dir]
browserswarm report   --run <dir>
```

Run `pnpm browserswarm <command> --help` for details. Defaults for every plan field are listed in
[test-plan-format.md](test-plan-format.md).
