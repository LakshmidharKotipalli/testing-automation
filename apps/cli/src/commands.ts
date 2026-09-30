import { applyModelOptions, type ModelOptions } from "./model-options.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  buildApprovedExecutionPlan,
  EDIT_INSTRUCTIONS,
  promptForDecision,
  recordDecision,
  riskConfirmationPhrase,
  type InteractiveDecision,
} from "@browserswarm/approval";
import {
  BrowserSwarmError,
  computePlanHash,
  ExecutionPlanSchema,
  formatZodIssues,
  runStateMachine,
  RunReportSchema,
  TrackedState,
  ValidationError,
  type ExecutionPlan,
  type RunMode,
  type RunState,
  type TestPlan,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import { generateExecutionPlan, renderExecutionPlanReview } from "@browserswarm/execution-planner";
import { executeApprovedPlan, type RunResult } from "@browserswarm/orchestrator";
import {
  compilePrompt,
  loadPlanFile,
  resolveRunMode,
  serializePlanYaml,
  validatePlan,
} from "@browserswarm/plan-compiler";
import { renderAutonomousReview, validatePlanAgainstProfile } from "@browserswarm/autonomous-planner";
import { loadProfile, runAutonomous, type AutonomousOptions, type ScopeFlags } from "./autonomous.js";
import { renderMarkdownReport } from "@browserswarm/reporters";
import {
  atomicWriteFile,
  ENV,
  readJsonFile,
  sha256,
  stableStringify,
  targetFromEnv,
} from "@browserswarm/shared";
import { FilesystemStorage, RunLayout } from "@browserswarm/storage";

export interface CliIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const EXIT = { OK: 0, TEST_FAILURES: 1, INVALID: 2, APPROVAL: 3, REJECTED: 4 } as const;

const out = (io: CliIO, s = "") => io.stdout.write(`${s}\n`);
const err = (io: CliIO, s: string) => io.stderr.write(`${s}\n`);
const abs = (io: CliIO, p: string) => path.resolve(io.cwd, p);

function reportValidation(io: CliIO, errors: string[], warnings: string[]): void {
  for (const w of warnings) err(io, `warning: ${w}`);
  for (const e of errors) err(io, `error: ${e}`);
}

/** Loads a plan file, resolving the target website from the central .env setting when the plan omits it. */
async function loadPlan(io: CliIO, file: string, opts: ModelOptions = {}) {
  const loaded = await loadPlanFile(abs(io, file), { env: io.env });
  loaded.plan = await applyModelOptions(loaded.plan, opts, io.env, io.cwd);
  if (loaded.targetSource === "env") {
    out(io, `Target: ${loaded.plan.target.url} (from ${ENV.TARGET_URL} in .env)`);
  }
  return loaded;
}

async function loadPlanFromOptions(
  io: CliIO,
  opts: ModelOptions & {
    plan?: string;
    prompt?: string;
    promptText?: string;
    url?: string;
    allowedDomain?: string[];
  },
): Promise<{
  plan: TestPlan;
  promptText?: string;
  rawPlanText?: string;
}> {
  if (opts.plan) {
    const loaded = await loadPlan(io, opts.plan, opts);
    return { plan: loaded.plan, rawPlanText: loaded.rawText };
  }
  if (opts.prompt || opts.promptText !== undefined) {
    // Precedence: --url flag, then the central BROWSERSWARM_TARGET_URL setting.
    const envTarget = targetFromEnv(io.env);
    const url = opts.url ?? envTarget?.url;
    if (!url) {
      throw new ValidationError("No target website configured", [
        `set ${ENV.TARGET_URL} in .env (see .env.example), or pass --url`,
      ]);
    }
    if (!opts.url) out(io, `Target: ${url} (from ${ENV.TARGET_URL} in .env)`);
    const allowedDomains = opts.allowedDomain?.length
      ? opts.allowedDomain
      : !opts.url && io.env[ENV.ALLOWED_DOMAINS]
        ? envTarget?.allowedDomains
        : undefined;
    const promptText = opts.prompt ? await readFile(abs(io, opts.prompt), "utf8") : (opts.promptText ?? "");
    const compiled = compilePrompt({ promptText, url, ...(allowedDomains ? { allowedDomains } : {}) });
    for (const a of compiled.assumptions) err(io, `assumption: ${a}`);
    for (const a of compiled.ambiguities) err(io, `ambiguity: ${a}`);
    return { plan: compiled.plan, promptText };
  }
  throw new ValidationError("missing option", [
    "provide --plan <file>, --prompt <file> or --prompt-text <text>",
  ]);
}

async function readExecutionPlan(file: string): Promise<ExecutionPlan> {
  const raw = await readJsonFile(file);
  const parsed = ExecutionPlanSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError("execution plan failed schema validation", formatZodIssues(parsed.error));
  return parsed.data;
}

/** `plan`: compile a natural-language prompt (or normalize a YAML/JSON plan) into an editable YAML plan. */
export async function cmdPlan(
  io: CliIO,
  opts: { url?: string; prompt?: string; plan?: string; output: string; allowedDomain?: string[] },
): Promise<number> {
  const { plan } = await loadPlanFromOptions(io, opts);
  const outputPath = abs(io, opts.output);
  await atomicWriteFile(outputPath, serializePlanYaml(plan));
  const report = validatePlan(plan);
  reportValidation(io, report.errors, report.warnings);
  out(
    io,
    `Wrote ${path.relative(io.cwd, outputPath)} (${plan.scenarios.length} scenario(s), plan hash ${report.planHash})`,
  );
  out(io, "Review and edit the plan, then run: browserswarm preview --plan <file>");
  return report.valid ? EXIT.OK : EXIT.INVALID;
}

export async function cmdValidate(io: CliIO, opts: ModelOptions & { plan: string }): Promise<number> {
  const { plan } = await loadPlan(io, opts.plan, opts);
  const report = validatePlan(plan);
  reportValidation(io, report.errors, report.warnings);
  out(
    io,
    report.valid
      ? `Plan is valid. Plan hash: ${report.planHash}`
      : `Plan is INVALID (${report.errors.length} error(s)).`,
  );
  if (report.riskFlags.length)
    out(
      io,
      `Risk flags: ${report.riskFlags.map((f) => `${f.scenarioId}#${f.stepIndex}:${f.category}`).join(", ")}`,
    );
  return report.valid ? EXIT.OK : EXIT.INVALID;
}

/** `preview`: generate the exact execution plan and print the approval review. Starts no browser. */
export async function cmdPreview(
  io: CliIO,
  opts: ModelOptions & { plan: string; parallel?: number; write?: string; runId?: string; profile?: string },
): Promise<number> {
  const { plan } = await loadPlan(io, opts.plan, opts);
  const profile = opts.profile ? await checkedProfile(io, plan, opts.profile) : undefined;
  const ep = generateExecutionPlan(plan, {
    ...(opts.parallel ? { parallel: opts.parallel } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
  out(io, profile ? renderAutonomousReview(profile, plan, ep) : renderExecutionPlanReview(ep));
  if (opts.write) {
    await atomicWriteFile(abs(io, opts.write), `${stableStringify(ep)}\n`);
    out(io, `Execution plan written to ${opts.write}`);
    out(
      io,
      `Approve with: browserswarm approve --plan ${opts.plan}${opts.profile ? ` --profile ${opts.profile}` : ""} --execution-plan ${opts.write}`,
    );
  }
  return EXIT.OK;
}

interface DecisionOptions {
  yes?: boolean;
  acceptRisk?: boolean;
  riskPlanHash?: string;
  operator?: string;
}

async function decide(
  io: CliIO,
  ep: ExecutionPlan,
  opts: DecisionOptions,
): Promise<InteractiveDecision & { mode: "interactive" | "noninteractive" }> {
  if (opts.yes) {
    if (ep.requiresExplicitRiskApproval && !(opts.acceptRisk && opts.riskPlanHash)) {
      throw new BrowserSwarmError(
        "RISK_APPROVAL_REQUIRED",
        `--yes refuses risky plans. Re-run with --accept-risk --risk-plan-hash ${ep.riskPlanHash} after reviewing the risky steps.`,
      );
    }
    out(io, "Noninteractive approval (--yes).");
    return {
      decision: "approve",
      mode: "noninteractive",
      ...(opts.acceptRisk
        ? {
            riskAcceptance: {
              accepted: true,
              ...(opts.riskPlanHash ? { riskPlanHash: opts.riskPlanHash } : {}),
            },
          }
        : {}),
    };
  }
  if (ep.requiresExplicitRiskApproval)
    out(io, `Risky plan: approving requires typing "${riskConfirmationPhrase(ep)}" when asked.`);
  const d = await promptForDecision(ep, { input: io.stdin, output: io.stdout });
  return { ...d, mode: "interactive" };
}

function operatorName(io: CliIO, opts: DecisionOptions): string {
  return opts.operator || io.env.BROWSERSWARM_OPERATOR || io.env.USER || "unknown-operator";
}

/** `approve`: bind an approval record to the exact execution plan and write the immutable approved plan. */
export async function cmdApprove(
  io: CliIO,
  opts: ModelOptions &
    DecisionOptions & { plan: string; executionPlan: string; output?: string; profile?: string },
): Promise<number> {
  const { plan } = await loadPlan(io, opts.plan, opts);
  const profile = opts.profile ? await checkedProfile(io, plan, opts.profile) : undefined;
  const epPath = abs(io, opts.executionPlan);
  const ep = await readExecutionPlan(epPath);
  if (ep.planHash !== computePlanHash(plan))
    throw new BrowserSwarmError(
      "APPROVAL_INVALIDATED",
      "the resolved plan and overrides changed after the execution plan was generated; run preview again",
    );
  out(io, profile ? renderAutonomousReview(profile, plan, ep) : renderExecutionPlanReview(ep));
  const d = await decide(io, ep, opts);
  const dir = path.dirname(epPath);
  return finishDecision(io, {
    plan,
    ep,
    decision: d,
    operator: operatorName(io, opts),
    dir,
    ...(opts.output ? { output: abs(io, opts.output) } : {}),
    planPath: opts.plan,
    ...(profile ? { discoveryProfileHash: profile.profileHash } : {}),
  });
}

/** Loads a profile and checks that the (possibly edited) autonomous plan still matches it. */
async function checkedProfile(io: CliIO, plan: TestPlan, file: string): Promise<WebsiteUnderstandingProfile> {
  const profile = await loadProfile(io, file);
  const errors = validatePlanAgainstProfile(plan, profile);
  if (errors.length) throw new ValidationError("plan does not match the discovery profile", errors);
  return profile;
}

async function finishDecision(
  io: CliIO,
  args: {
    plan: TestPlan;
    ep: ExecutionPlan;
    decision: InteractiveDecision & { mode: "interactive" | "noninteractive" };
    operator: string;
    dir: string;
    output?: string;
    planPath?: string;
    discoveryProfileHash?: string;
  },
): Promise<number> {
  const { plan, ep, decision } = args;
  const record = recordDecision({
    executionPlan: ep,
    plan,
    decision: decision.decision,
    mode: decision.mode,
    operator: args.operator,
    ...(args.discoveryProfileHash ? { discoveryProfileHash: args.discoveryProfileHash } : {}),
    ...(decision.riskAcceptance ? { riskAcceptance: decision.riskAcceptance } : {}),
  });
  switch (decision.decision) {
    case "approve": {
      const approved = buildApprovedExecutionPlan(ep, record);
      const target = args.output ?? path.join(args.dir, "approved-execution-plan.json");
      await atomicWriteFile(target, `${stableStringify(approved)}\n`);
      await atomicWriteFile(
        path.join(path.dirname(target), "approval-record.json"),
        `${stableStringify(record)}\n`,
      );
      out(io, `Approved. Immutable approved plan: ${path.relative(io.cwd, target)}`);
      out(io, `Approval ${record.approvalId} bound to execution plan ${ep.executionPlanHash}`);
      return EXIT.OK;
    }
    case "reject":
      await atomicWriteFile(path.join(args.dir, "approval-rejection.json"), `${stableStringify(record)}\n`);
      out(io, "Rejected. No browser was started.");
      return EXIT.REJECTED;
    case "export":
      await atomicWriteFile(path.join(args.dir, "execution-plan.json"), `${stableStringify(ep)}\n`);
      await atomicWriteFile(path.join(args.dir, "compiled-plan.yaml"), serializePlanYaml(plan));
      out(
        io,
        `Exported plan and execution plan to ${path.relative(io.cwd, args.dir) || "."}. Nothing was run.`,
      );
      return EXIT.OK;
    case "edit":
      out(io, EDIT_INSTRUCTIONS);
      return EXIT.OK;
  }
  return EXIT.INVALID;
}

export interface RunCommandOptions extends DecisionOptions, ScopeFlags, ModelOptions {
  approvedPlan?: string;
  plan?: string;
  prompt?: string;
  promptText?: string;
  mode?: RunMode;
  confirmAuthorized?: boolean;
  discoveryConfig?: string;
  /** Test seams (not CLI flags). */
  discoverySessionFactory?: AutonomousOptions["discoverySessionFactory"];
  runSessionFactory?: AutonomousOptions["runSessionFactory"];
  url?: string;
  allowedDomain?: string[];
  parallel?: number;
  output?: string;
}

/**
 * `run`: execute an approved plan, or (interactive shortcut) compile -> validate -> generate -> display ->
 * approve -> run. No browser, context or agent starts before an approval record exists.
 */
export async function cmdRun(io: CliIO, opts: RunCommandOptions, signal?: AbortSignal): Promise<number> {
  if (opts.approvedPlan) {
    const raw = await readJsonFile(abs(io, opts.approvedPlan));
    if (opts.provider || opts.model || opts.headed || opts.persistentProfile || opts.modelProfile)
      throw new Error("Execution options cannot change an approved plan; preview and approve again");
    const currentPlan = opts.plan ? (await loadPlan(io, opts.plan, opts)).plan : undefined;
    const executionPlan = (
      raw as {
        executionPlan?: {
          models?: Record<string, { provider?: string; model?: string; baseUrl?: string } | null>;
          browser?: { channel?: string };
        };
      }
    ).executionPlan;
    const expectedProvider =
      io.env.BROWSERSWARM_LLM_PROVIDER === "opencode"
        ? "opencode-agent"
        : io.env.BROWSERSWARM_LLM_PROVIDER === "openrouter"
          ? "openrouter"
          : undefined;
    const configuredModel = executionPlan?.models && Object.values(executionPlan.models).find(Boolean);
    if (
      (expectedProvider && configuredModel?.provider !== expectedProvider) ||
      (io.env.BROWSERSWARM_LLM_MODEL && configuredModel?.model !== io.env.BROWSERSWARM_LLM_MODEL) ||
      (io.env.BROWSERSWARM_LLM_BASE_URL && configuredModel?.baseUrl !== io.env.BROWSERSWARM_LLM_BASE_URL) ||
      (io.env.BROWSERSWARM_BROWSER_CHANNEL &&
        executionPlan?.browser?.channel !== io.env.BROWSERSWARM_BROWSER_CHANNEL)
    )
      throw new BrowserSwarmError(
        "APPROVAL_INVALIDATED",
        "environment model or browser overrides differ from the approved plan; preview and approve again",
      );
    // The approved plan is bound to one website. If .env now points elsewhere, require a fresh approval
    // instead of silently testing the old site.
    const approvedUrl = (raw as { executionPlan?: { target?: { url?: string } } }).executionPlan?.target?.url;
    const envTarget = targetFromEnv(io.env);
    if (envTarget && approvedUrl && envTarget.url !== approvedUrl) {
      throw new BrowserSwarmError(
        "APPROVAL_INVALIDATED",
        `the approved plan targets ${approvedUrl} but ${ENV.TARGET_URL} in .env is ${envTarget.url}; run preview and approve again`,
      );
    }
    const runId = (raw as { executionPlan?: { runId?: string } }).executionPlan?.runId ?? "run";
    const outputDir = abs(io, opts.output ?? path.join("artifacts", runId));
    const result = await executeApprovedPlan(raw, {
      outputDir,
      env: io.env,
      ...(currentPlan ? { currentPlan } : {}),
      ...(opts.runSessionFactory ? { sessionFactory: opts.runSessionFactory } : {}),
      ...(signal ? { signal } : {}),
    });
    printRunSummary(io, result);
    return result.exitCode;
  }

  // Mode: --mode wins; a structured plan is instruction-led; a prompt is inspected; a URL alone is autonomous.
  if (opts.mode === "autonomous" && opts.plan)
    throw new ValidationError("--mode autonomous cannot be combined with --plan", [
      "a structured plan is instruction-led; drop --plan to discover the site, or drop --mode",
    ]);
  const promptText = opts.prompt ? await readFile(abs(io, opts.prompt), "utf8") : opts.promptText;
  const mode = resolveRunMode({
    ...(opts.mode ? { explicitMode: opts.mode } : {}),
    planProvided: !!opts.plan,
    ...(promptText !== undefined ? { promptText } : {}),
  });
  if (mode.mode === "autonomous") {
    return runAutonomous(
      io,
      {
        ...opts,
        ...(promptText !== undefined ? { promptText } : {}),
        mode,
      },
      signal,
    );
  }
  if (!opts.plan && promptText === undefined)
    throw new ValidationError("instruction-led mode needs instructions", [
      "provide --plan <file>, --prompt <file> or --prompt-text <text>, or use --mode autonomous",
    ]);
  for (const r of mode.reasons) out(io, `Mode: instruction-led (${r})`);

  const history: { state: RunState; at: string; reason?: string }[] = [];
  const state = new TrackedState<RunState>(runStateMachine, "DRAFT", (_f, to, reason) =>
    history.push(
      reason
        ? { state: to, at: new Date().toISOString(), reason }
        : { state: to, at: new Date().toISOString() },
    ),
  );
  history.push({ state: "DRAFT", at: new Date().toISOString() });
  const loaded = await loadPlanFromOptions(io, {
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(promptText !== undefined && !opts.plan ? { promptText } : {}),
    ...(opts.url ? { url: opts.url } : {}),
    ...(opts.allowedDomain ? { allowedDomain: opts.allowedDomain } : {}),
  });
  let { plan } = loaded;
  const rawPlanText = loaded.rawPlanText;
  plan = await applyModelOptions(plan, opts, io.env, io.cwd);
  state.to("COMPILED");
  const validation = validatePlan(plan);
  reportValidation(io, validation.errors, validation.warnings);
  if (!validation.valid) {
    state.to("FAILED", "validation failed");
    return EXIT.INVALID;
  }
  state.to("VALIDATED");
  const ep = generateExecutionPlan(plan, opts.parallel ? { parallel: opts.parallel } : {});
  state.to("EXECUTION_PLAN_GENERATED");

  const outputDir = abs(io, opts.output ?? path.join("artifacts", ep.runId));
  const storage = new FilesystemStorage(outputDir);
  if (promptText !== undefined && !opts.plan) {
    await storage.writeText(RunLayout.metadata.originalPrompt, promptText);
    await storage.writeText(RunLayout.metadata.originalPromptHash, `${sha256(promptText)}\n`);
  }
  const planYaml = rawPlanText ?? serializePlanYaml(plan);
  await storage.writeText(RunLayout.metadata.compiledPlan, planYaml);
  await storage.writeText(RunLayout.metadata.compiledPlanHash, `${validation.planHash}\n`);
  await storage.writeJson(RunLayout.metadata.executionPlan, ep);
  await storage.writeText(RunLayout.metadata.executionPlanHash, `${ep.executionPlanHash}\n`);

  state.to("PENDING_APPROVAL");
  out(io, renderExecutionPlanReview(ep));
  const d = await decide(io, ep, opts);
  const metadataDir = storage.resolve("metadata");
  if (d.decision !== "approve") {
    state.to("CANCELLED", `user decision: ${d.decision}`);
    await storage.writeJson(RunLayout.metadata.run, {
      runId: ep.runId,
      state: state.state,
      stateHistory: history,
    });
    return finishDecision(io, { plan, ep, decision: d, operator: operatorName(io, opts), dir: metadataDir });
  }
  const record = recordDecision({
    executionPlan: ep,
    plan,
    decision: "approve",
    mode: d.mode,
    operator: operatorName(io, opts),
    ...(d.riskAcceptance ? { riskAcceptance: d.riskAcceptance } : {}),
  });
  const approved = buildApprovedExecutionPlan(ep, record);
  await storage.writeJson(RunLayout.metadata.approvalRecord, record);
  await storage.writeJson(RunLayout.metadata.approvedExecutionPlan, approved);
  out(io, `Approved (${record.approvalId}). Starting run ${ep.runId}.`);
  const result = await executeApprovedPlan(approved, {
    outputDir,
    currentPlan: plan,
    env: io.env,
    priorStateHistory: history,
    ...(opts.runSessionFactory ? { sessionFactory: opts.runSessionFactory } : {}),
    ...(signal ? { signal } : {}),
  });
  printRunSummary(io, result);
  return result.exitCode;
}

function printRunSummary(io: CliIO, r: RunResult): void {
  const e = r.report.execution;
  out(io);
  out(io, `Run ${r.runId}: ${r.state}`);
  out(
    io,
    `  packets: ${e.packetCount} (passed ${e.packetsPassed}, failed ${e.packetsFailed}, blocked ${e.packetsBlocked}, error ${e.packetsErrored}, cancelled ${e.packetsCancelled})`,
  );
  out(
    io,
    `  actions: ${e.totalActions} deterministic, LLM calls: ${e.llmCalls}, checkpoints: ${e.checkpointCount}, handoffs: ${e.handoffCount}`,
  );
  out(io, `  findings: ${r.report.findings.length}`);
  for (const f of r.reportFiles) out(io, `  report: ${path.relative(io.cwd, f)}`);
  for (const d of r.deferredReports) out(io, `  report deferred: ${d}`);
  out(io, `  artifacts: ${path.relative(io.cwd, r.outputDir)}`);
}

/** `report`: re-render the Markdown report from a run's report.json. */
export async function cmdReport(io: CliIO, opts: { run: string }): Promise<number> {
  const storage = new FilesystemStorage(abs(io, opts.run));
  const report = RunReportSchema.parse(await storage.readJson(RunLayout.reports.json));
  const md = renderMarkdownReport(report);
  await storage.writeText(RunLayout.reports.markdown, md);
  out(io, md);
  return EXIT.OK;
}

/** `discover`: authorized read-only discovery, profile, generated plan and review. Executes no test. */
export async function cmdDiscover(
  io: CliIO,
  opts: Omit<AutonomousOptions, "stopAfterPlan" | "mode"> & { prompt?: string },
  signal?: AbortSignal,
): Promise<number> {
  const promptText = opts.prompt ? await readFile(abs(io, opts.prompt), "utf8") : opts.promptText;
  return runAutonomous(
    io,
    {
      ...opts,
      ...(promptText !== undefined ? { promptText } : {}),
      mode: { mode: "autonomous", reasons: ["discover command"] },
      stopAfterPlan: true,
    },
    signal,
  );
}

export { cmdAutonomousPlan } from "./autonomous.js";
