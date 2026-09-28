# OpenCode integration

OpenCode is the intended way to connect models. BrowserSwarm depends on no model vendor SDK.

## Credentials

Two options, both vendor-neutral:

1. **API key in `.env`** (central configuration):
   ```bash
   BROWSERSWARM_LLM_API_KEY=sk-...
   BROWSERSWARM_LLM_API_KEY_ENV=ANTHROPIC_API_KEY   # the variable OpenCode / the provider reads
   ```
   A model can override the variable name with `apiKeyEnv` in its model reference. The key is exported to
   the OpenCode child process only (never to other processes, and not under the `BROWSERSWARM_` name), is
   never stored in plans, approval files, artifacts or reports, never appears in prompts, and is registered
   with every redactor.
2. **OpenCode's own login**: leave `BROWSERSWARM_LLM_API_KEY` empty and OpenCode uses its stored credentials.

## Assumptions (and how to adapt)

BrowserSwarm does **not** assume a fixed OpenCode CLI syntax. It runs a configurable command:

```yaml
models:
  default:
    provider: opencode-cli
    command: opencode
    argsTemplate: ["run", "--model", "{model}", "--output", "json"] # EXAMPLE ONLY
    model: provider/model-id
    timeoutMs: 120000
    contextWindowTokens: 128000
    outputFormat: json # or text-json-block
  overrides:
    verifier:
      provider: opencode-cli
      model: provider/stronger-model
```

- `argsTemplate` placeholders: `{model}`, `{maxTokens}`. Check `opencode --help` (or your version's docs)
  and adjust the template; nothing else in BrowserSwarm depends on the argument shape.
- The prompt is always written to **stdin** (never argv, so it does not appear in process listings).
- The child process receives only an environment allowlist (plus the API key from `.env`, when set) (`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`,
  `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` by default) so OpenCode can find its own configuration.
- Output parsing: `json` accepts a single JSON document or NDJSON events; text is taken from `text`,
  `content`, `output`, `response`, `message.content`, `result` or `part.text`; usage from
  `usage.input_tokens|inputTokens|prompt_tokens` and `usage.output_tokens|outputTokens|completion_tokens`.
  `text-json-block` returns stdout as text and the structured-output layer extracts the JSON.
- When usage is not reported, tokens are estimated conservatively and marked `exact: false`.
- Prompts are passed through the run's redactor before leaving the process.

## Structured output

`generateStructured()` requires strict JSON validated by a Zod schema, with `maxRepairAttempts` repair
rounds that include the validation errors. Failure raises `LLM_OUTPUT_INVALID`.

## LLM strategies

| Strategy        | Behavior                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`      | Default. Zero LLM calls.                                                                                                                                                                                                                                                                                                                                |
| `fallback-only` | A model may be called only on an allowed trigger (e.g. `locator_not_found`) and only to re-target the approved step. It cannot decide what to test, add scenarios, alter expectations or relax policy. Every proposal is schema-validated and policy-checked, recorded in the ledger (`llmInvolved: true`) and counted against the packet's LLM budget. |
| `guided`        | Reserved for later milestones; subject to the same constraints.                                                                                                                                                                                                                                                                                         |

Milestone status: the client, mock client, structured output and policy check for proposals ship in
Milestone 1; wiring fallback into execution, verifier packets and LLM resume prompts arrive in Milestone 4.

## Testing without a model

`MockLLMClient` returns scripted responses and can simulate growing context, small context windows,
malformed output and process failures. See `examples/long-running-agent-handoff/mock-context-rotation.json`.
