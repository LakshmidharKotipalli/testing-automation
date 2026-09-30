import path from "node:path";
import {
  AUTONOMOUS_EDIT_INSTRUCTIONS,
  buildApprovedExecutionPlan,
  promptForAutonomousDecision,
  promptYesNo,
  recordDecision,
  riskConfirmationPhrase,
  type InteractiveDecision,
} from "@browserswarm/approval";
import { AutonomousTestPlanGenerator, renderAutonomousReview } from "@browserswarm/autonomous-planner";
import type { SessionFactory } from "@browserswarm/mcp-browser";
import {
  AgentRoleSchema,
  BrowserConfigSchema,
  BrowserSwarmError,
  computeProfileHash,
  ContextPolicySchema,
  DiscoveryPolicySchema,
  formatZodIssues,
  ModelRefSchema,
  runStateMachine,
  TrackedState,
  ValidationError,
  WebsiteUnderstandingProfileSchema,
  type AgentRole,
  type ExecutionPlan,
  type ModelRef,
  type RunPhase,
  type RunState,
  type WebsiteUnderstandingProfile,
} from "@browserswarm/core";
import {
  createDiscoveryPacket,
  recordDiscoveryAuthorization,
  renderDiscoveryPreflight,
  runDiscoveryPhase,
} from "@browserswarm/discovery";
import { MockLLMClient, OpenCodeCliClient, type LLMClient } from "@browserswarm/opencode-adapter";
import { executeApprovedPlan } from "@browserswarm/orchestrator";
import {
  parsePlanText,
  resolveScope,
  serializePlanYaml,
  type ModeResolution,
  type ScopeSelection,
} from "@browserswarm/plan-compiler";
import {
  atomicWriteFile,
  createRedactor,
  ENV,
  envSecrets,
  newRunId,
  readJsonFile,
  stableStringify,
  targetFromEnv,
} from "@browserswarm/shared";
import { EventStore, FilesystemStorage, RunLayout } from "@browserswarm/storage";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { CliIO } from "./commands.js";

const EXIT = { OK: 0, TEST_FAILURES: 1, INVALID: 2, APPROVAL: 3, REJECTED: 4 } as const;
const out = (io: CliIO, s = "") => io.stdout.write(`${s}\n`);
const err = (io: CliIO, s: string) => io.stderr.write(`${s}\n`);
const abs = (io: CliIO, p: string) => path.resolve(io.cwd, p);

export interface ScopeFlags {
  excludeScenario?: string[];
  excludeRoute?: string[];
  excludeRole?: string[];
  excludeCategory?: string[];
  onlyRole?: string[];
}

export interface AutonomousOptions extends ScopeFlags {
  url?: string;
  allowedDomain?: string[];
  promptText?: string;
  parallel?: number;
  output?: string;
  discoveryConfig?: string;
  confirmAuthorized?: boolean;
  yes?: boolean;
  acceptRisk?: boolean;
  riskPlanHash?: string;
  operator?: string;
  mode?: ModeResolution;
  /** `discover` command: stop at PENDING_APPROVAL (discovery + plan + review, nothing executed). */
  stopAfterPlan?: boolean;
  /** Test seams: browser launchers for the discovery phase and the approved run. */
  discoverySessionFactory?: SessionFactory;
  runSessionFactory?: SessionFactory;
  llmClient?: LLMClient;
}

/** Optional YAML/JSON configuration for autonomous runs (discovery limits, browser, models, llm). */
interface AutonomousConfig {
  discovery?: unknown;
  browser?: unknown;
  contextLifecycle?: unknown;
  discoveryModel?: unknown;
  models?: unknown;
  llm?: unknown;
}

function toSelection(flags: ScopeFlags, maxConcurrency?: number): Partial<ScopeSelection> {
  const roles = (xs: string[] | undefined): AgentRole[] =>
    (xs ?? []).map((r) => {
      const parsed = AgentRoleSchema.safeParse(r);
      if (!parsed.success)
        throw new ValidationError(`unknown agent role "${r}"`, [
          `valid roles: ${AgentRoleSchema.options.join(", ")}`,
        ]);
      return parsed.data;
    });
  return {
    excludeScenarios: flags.excludeScenario ?? [],
    excludeRoutes: flags.excludeRoute ?? [],
    excludeRoles: roles(flags.excludeRole),
    excludeCategories: flags.excludeCategory ?? [],
    onlyRoles: roles(flags.onlyRole),
    ...(maxConcurrency ? { maxConcurrency } : {}),
  };
}

function operatorName(io: CliIO, operator?: string): string {
  return operator || io.env.BROWSERSWARM_OPERATOR || io.env.USER || "unknown-operator";
}

async function loadConfig(io: CliIO, file?: string): Promise<AutonomousConfig> {
  if (!file) return {};
  const text = await readFile(abs(io, file), "utf8");
  const raw = parsePlanText(text, file.endsWith(".json") ? "json" : "yaml");
  if (!raw || typeof raw !== "object")
    throw new ValidationError("discovery config must be an object", [file]);
  return raw as AutonomousConfig;
}

function llmClientFor(model: ModelRef | null, env: NodeJS.ProcessEnv): LLMClient | undefined {
  if (!model) return undefined;
  if (model.provider === "mock") return new MockLLMClient({ responses: [{ kind: "text", text: "{}" }] });
  return OpenCodeCliClient.fromModelRef(model, { redactor: createRedactor(envSecrets(env)) }, env);
}

function resolveTarget(
  io: CliIO,
  opts: { url?: string; allowedDomain?: string[] },
): { url: string; allowedDomains: string[] } {
  const envTarget = targetFromEnv(io.env);
  const url = opts.url ?? envTarget?.url;
  if (!url) {
    throw new ValidationError("No target website configured", [
      `set ${ENV.TARGET_URL} in .env (see .env.example), or pass --url`,
    ]);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("invalid target URL", [url]);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ValidationError("target must be http(s)", [url]);
  if (!opts.url) out(io, `Target: ${url} (from ${ENV.TARGET_URL} in .env)`);
  const allowedDomains = opts.allowedDomain?.length
    ? opts.allowedDomain
    : !opts.url && io.env[ENV.ALLOWED_DOMAINS] && envTarget
      ? envTarget.allowedDomains
      : [parsed.hostname];
  return { url, allowedDomains };
}

/**
 * Autonomous discovery-led run:
 * DRAFT -> DISCOVERY_PLANNED (preflight + authorization) -> DISCOVERY_RUNNING (one read-only Discovery Lead
 * Agent) -> DISCOVERY_COMPLETED -> WEBSITE_PROFILE_GENERATED -> TEST_PLAN_GENERATED -> EXECUTION_PLAN_GENERATED
 * -> PENDING_APPROVAL -> (approve-safe-plan) APPROVED -> RUNNING -> ... No test subagent starts before approval.
 */
export async function runAutonomous(
  io: CliIO,
  opts: AutonomousOptions,
  signal?: AbortSignal,
): Promise<number> {
  // One line reader for every question in this flow (authorization, then the plan decision).
  let rl: ReturnType<typeof createInterface> | undefined;
  let lines: AsyncIterator<string> | undefined;
  const prompt = () => {
    if (!rl || !lines) {
      rl = createInterface({ input: io.stdin, terminal: false });
      lines = rl[Symbol.asyncIterator]();
    }
    return { input: io.stdin, output: io.stdout, lines };
  };
  try {
    return await runAutonomousFlow(io, opts, prompt, signal);
  } finally {
    rl?.close();
  }
}

type PromptFactory = () => { input: CliIO["stdin"]; output: CliIO["stdout"]; lines: AsyncIterator<string> };

async function runAutonomousFlow(
  io: CliIO,
  opts: AutonomousOptions,
  prompt: PromptFactory,
  signal?: AbortSignal,
): Promise<number> {
  const target = resolveTarget(io, opts);
  const cfg = await loadConfig(io, opts.discoveryConfig);
  const runId = newRunId();
  const outputDir = abs(io, opts.output ?? path.join("artifacts", runId));
  const storage = new FilesystemStorage(outputDir);
  const events = new EventStore(storage, runId, RunLayout.discovery.events);
  const history: { state: RunState; at: string; reason?: string }[] = [
    { state: "DRAFT", at: new Date().toISOString() },
  ];
  let phase: RunPhase = "discovery";
  const state = new TrackedState<RunState>(runStateMachine, "DRAFT", (from, to, reason) => {
    history.push(
      reason
        ? { state: to, at: new Date().toISOString(), reason }
        : { state: to, at: new Date().toISOString() },
    );
    events.emit({ type: "run.state.changed", data: { from, to, phase, ...(reason ? { reason } : {}) } });
  });
  // The discovery phase fills this after the initial run metadata has been written.
  // eslint-disable-next-line prefer-const
  let profileHash: string | undefined;
  const writeRun = () =>
    storage.writeJson(RunLayout.metadata.run, {
      runId,
      mode: "autonomous",
      state: state.state,
      phase,
      stateHistory: history,
      ...(profileHash ? { discoveryProfileHash: profileHash } : {}),
    });
  const finish = async (code: number) => {
    await events.flush();
    await writeRun();
    return code;
  };

  // ---- DISCOVERY_PLANNED: exact, hash-bound discovery packet + operator authorization ------------------
  type ZodErr = Parameters<typeof formatZodIssues>[0];
  const check = <T>(r: { success: true; data: T } | { success: false; error: ZodErr }, what: string): T => {
    if (!r.success) throw new ValidationError(`invalid ${what} configuration`, formatZodIssues(r.error));
    return r.data;
  };
  const discoveryModel = cfg.discoveryModel
    ? check(ModelRefSchema.safeParse(cfg.discoveryModel), "discoveryModel")
    : null;
  const packet = createDiscoveryPacket(
    {
      targetUrl: target.url,
      allowedDomains: target.allowedDomains,
      allowSubdomains: false,
      ...(opts.promptText ? { userIntent: opts.promptText.slice(0, 2000) } : {}),
      mode: "autonomous",
      discoveryPolicy: check(DiscoveryPolicySchema.safeParse(cfg.discovery ?? {}), "discovery"),
      browser: check(BrowserConfigSchema.safeParse(cfg.browser ?? {}), "browser"),
      model: discoveryModel,
      contextLifecycle: check(ContextPolicySchema.safeParse(cfg.contextLifecycle ?? {}), "contextLifecycle"),
    },
    runId,
  );
  state.to("DISCOVERY_PLANNED");
  events.emit({ type: "discovery.planned", data: { packetHash: packet.packetHash, target: target.url } });
  await storage.writeJson(RunLayout.discovery.packet, packet);
  out(io, renderDiscoveryPreflight(packet));
  if (opts.mode) for (const r of opts.mode.reasons) out(io, `Mode: autonomous (${r})`);

  let authMode: "interactive" | "noninteractive";
  if (opts.confirmAuthorized) {
    authMode = "noninteractive";
    out(io, "Authorization confirmed with --confirm-authorized.");
  } else if (opts.yes) {
    throw new BrowserSwarmError(
      "APPROVAL_REQUIRED",
      "--yes does not authorize discovery. Add --confirm-authorized to state that you are authorized to test this target.",
    );
  } else {
    authMode = "interactive";
    const ok = await promptYesNo("> ", prompt());
    if (!ok) {
      state.to("CANCELLED", "discovery not authorized");
      out(io, "Discovery not authorized. No browser was started.");
      return finish(EXIT.REJECTED);
    }
  }
  const authorization = recordDiscoveryAuthorization({
    packet,
    operator: operatorName(io, opts.operator),
    mode: authMode,
  });
  events.emit({
    type: "discovery.authorized",
    data: { authorizationId: authorization.authorizationId, mode: authMode },
  });

  // ---- DISCOVERY_RUNNING: exactly one read-only Discovery Lead Agent ------------------------------------
  state.to("DISCOVERY_RUNNING");
  await writeRun();
  const redactor = createRedactor(envSecrets(io.env));
  const llmClient = opts.llmClient ?? llmClientFor(discoveryModel, io.env);
  let phaseResult;
  try {
    phaseResult = await runDiscoveryPhase({
      packet,
      authorization,
      storage,
      events,
      redactor,
      ...(opts.discoverySessionFactory ? { sessionFactory: opts.discoverySessionFactory } : {}),
      ...(io.env.BROWSERSWARM_CHROMIUM_EXECUTABLE
        ? { executablePath: io.env.BROWSERSWARM_CHROMIUM_EXECUTABLE }
        : {}),
      ...(signal ? { signal } : {}),
      ...(opts.promptText ? { userIntent: opts.promptText } : {}),
      ...(llmClient && discoveryModel
        ? { llm: { client: llmClient, model: discoveryModel, maxTokens: 1500, maxRepairAttempts: 1 } }
        : {}),
      onDiscoveryCompleted: (r) => {
        if (r.status === "partial" && signal?.aborted) return;
        state.to("DISCOVERY_COMPLETED", `${r.status}: ${r.stopReason}`.slice(0, 300));
      },
    });
  } catch (error) {
    if (state.state === "DISCOVERY_RUNNING") state.to("FAILED", (error as Error).message.slice(0, 300));
    await finish(EXIT.TEST_FAILURES);
    throw error;
  }
  const { profile, result } = phaseResult;
  profileHash = profile.profileHash;
  out(
    io,
    `Discovery ${profile.discoveryStatus}: ${result.stats.routesVisited}/${result.stats.routesDiscovered} routes visited, ${result.restricted.length} restricted control(s) recorded and not used.`,
  );
  out(io, `Discovery report: ${path.relative(io.cwd, storage.resolve(RunLayout.discovery.reportMarkdown))}`);
  if (signal?.aborted) {
    state.to("CANCELLED", "cancelled by user");
    return finish(130);
  }
  state.to("WEBSITE_PROFILE_GENERATED");
  if (profile.discoveryStatus === "failed" || profile.discoveryStatus === "blocked") {
    state.to("FAILED", `discovery ${profile.discoveryStatus}: ${result.stopReason}`.slice(0, 300));
    err(io, `Discovery ${profile.discoveryStatus}: ${result.stopReason}. No test plan was generated.`);
    return finish(EXIT.TEST_FAILURES);
  }

  // ---- planning -----------------------------------------------------------------------------------------
  phase = "planning";
  const mode: ModeResolution = opts.mode ?? { mode: "autonomous", reasons: ["autonomous mode"] };
  const scope = resolveScope({
    mode,
    ...(opts.promptText ? { promptText: opts.promptText } : {}),
    cli: toSelection(opts, opts.parallel),
  });
  for (const c of scope.record.conflicts) err(io, `scope conflict: ${c}`);
  const generated = generatePlan(profile, {
    selection: scope.selection,
    scopeRecord: scope.record,
    ...(opts.promptText ? { userIntent: opts.promptText } : {}),
    runId,
    ...(opts.parallel ? { parallel: opts.parallel } : {}),
    config: cfg,
  });
  if ("error" in generated) {
    state.to("FAILED", generated.error.slice(0, 300));
    err(io, generated.error);
    return finish(EXIT.INVALID);
  }
  const { testPlan, executionPlan: ep } = generated.result;
  state.to("TEST_PLAN_GENERATED");
  events.emit({
    type: "plan.generated",
    data: { planHash: ep.planHash, scenarios: testPlan.scenarios.length },
  });
  await storage.writeText(RunLayout.metadata.compiledPlan, serializePlanYaml(testPlan));
  await storage.writeText(RunLayout.metadata.compiledPlanHash, `${ep.planHash}\n`);
  await storage.writeText(RunLayout.discovery.testPlanSummary, generated.result.summaryMarkdown);
  await storage.writeJson(RunLayout.discovery.evidenceMap, generated.result.evidenceMap);
  await storage.writeJson(RunLayout.metadata.executionPlan, ep);
  await storage.writeText(RunLayout.metadata.executionPlanHash, `${ep.executionPlanHash}\n`);
  state.to("EXECUTION_PLAN_GENERATED");

  // ---- PENDING_APPROVAL ----------------------------------------------------------------------------------
  phase = "approval";
  state.to("PENDING_APPROVAL");
  await writeRun();
  out(io, renderAutonomousReview(profile, testPlan, ep));
  const metadataDir = storage.resolve("metadata");
  if (opts.stopAfterPlan) {
    out(io, "Discovery and planning complete. Nothing was executed.");
    out(io, `Plan: ${path.relative(io.cwd, storage.resolve(RunLayout.metadata.compiledPlan))}`);
    out(io, `Profile: ${path.relative(io.cwd, storage.resolve(RunLayout.discovery.profileJson))}`);
    out(
      io,
      `Approve and run with: browserswarm run --plan ${path.relative(io.cwd, storage.resolve(RunLayout.metadata.compiledPlan))}`,
    );
    return finish(EXIT.OK);
  }
  const decision = await decideAutonomous(io, ep, opts, prompt);
  const operator = operatorName(io, opts.operator);
  if (decision.decision === "export") {
    const planPath = path.join(metadataDir, "autonomous-plan.yaml");
    await atomicWriteFile(planPath, serializePlanYaml(testPlan));
    await atomicWriteFile(path.join(metadataDir, "execution-plan.json"), `${stableStringify(ep)}\n`);
    state.to("CANCELLED", "exported for editing (nothing executed)");
    out(io, `Exported ${path.relative(io.cwd, planPath)}. Nothing was executed.`);
    out(
      io,
      AUTONOMOUS_EDIT_INSTRUCTIONS.replace(
        /<website-understanding-profile\.json>/g,
        path.relative(io.cwd, storage.resolve(RunLayout.discovery.profileJson)),
      ),
    );
    return finish(EXIT.OK);
  }
  const record = recordDecision({
    executionPlan: ep,
    plan: testPlan,
    decision: decision.decision === "approve" ? "approve" : "reject",
    mode: decision.mode,
    operator,
    discoveryProfileHash: profile.profileHash,
    ...(decision.riskAcceptance ? { riskAcceptance: decision.riskAcceptance } : {}),
  });
  if (decision.decision !== "approve") {
    await atomicWriteFile(path.join(metadataDir, "approval-rejection.json"), `${stableStringify(record)}\n`);
    state.to("CANCELLED", "user decision: reject");
    out(io, "Rejected. No test subagent was started.");
    return finish(EXIT.REJECTED);
  }
  const approved = buildApprovedExecutionPlan(ep, record);
  await storage.writeJson(RunLayout.metadata.approvalRecord, record);
  await storage.writeJson(RunLayout.metadata.approvedExecutionPlan, approved);
  out(io, `Approved (${record.approvalId}). Starting ${ep.workPackets.length} approved work packet(s).`);
  await events.flush();
  // History up to PENDING_APPROVAL; the orchestrator records APPROVED -> RUNNING -> terminal.
  const result2 = await executeApprovedPlan(approved, {
    outputDir,
    currentPlan: testPlan,
    env: io.env,
    priorStateHistory: history,
    ...(opts.runSessionFactory ? { sessionFactory: opts.runSessionFactory } : {}),
    ...(signal ? { signal } : {}),
  });
  const e = result2.report.execution;
  out(io);
  out(io, `Run ${result2.runId}: ${result2.state}`);
  out(
    io,
    `  packets: ${e.packetCount} (passed ${e.packetsPassed}, failed ${e.packetsFailed}, blocked ${e.packetsBlocked}, error ${e.packetsErrored}, cancelled ${e.packetsCancelled})`,
  );
  out(io, `  findings: ${result2.report.findings.length}`);
  for (const f of result2.reportFiles) out(io, `  report: ${path.relative(io.cwd, f)}`);
  out(io, `  discovery: ${path.relative(io.cwd, storage.resolve(RunLayout.discovery.dir))}`);
  return result2.exitCode;
}

function generatePlan(
  profile: WebsiteUnderstandingProfile,
  input: Omit<Parameters<AutonomousTestPlanGenerator["generate"]>[0], "profile" | "config"> & {
    config?: AutonomousConfig;
  },
): { result: ReturnType<AutonomousTestPlanGenerator["generate"]> } | { error: string } {
  const { config, ...rest } = input;
  try {
    return {
      result: new AutonomousTestPlanGenerator().generate({
        profile,
        ...rest,
        config: {
          ...(config?.browser ? { browser: config.browser as never } : {}),
          ...(config?.models ? { models: config.models as never } : {}),
          ...(config?.llm ? { llm: config.llm as never } : {}),
        },
      }),
    };
  } catch (error) {
    if (error instanceof ValidationError) return { error: error.message };
    throw error;
  }
}

async function decideAutonomous(
  io: CliIO,
  ep: ExecutionPlan,
  opts: AutonomousOptions,
  prompt: PromptFactory,
): Promise<InteractiveDecision & { mode: "interactive" | "noninteractive" }> {
  if (opts.yes) {
    if (ep.requiresExplicitRiskApproval && !(opts.acceptRisk && opts.riskPlanHash))
      throw new BrowserSwarmError(
        "RISK_APPROVAL_REQUIRED",
        `--yes refuses risky plans (risk plan hash ${ep.riskPlanHash}).`,
      );
    out(io, "Noninteractive approval (--yes): approve-safe-plan.");
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
  const d = await promptForAutonomousDecision(ep, prompt());
  return { ...d, mode: "interactive" };
}

/** Loads and verifies a saved Website Understanding Profile. */
export async function loadProfile(io: CliIO, file: string): Promise<WebsiteUnderstandingProfile> {
  const raw = await readJsonFile(abs(io, file));
  const parsed = WebsiteUnderstandingProfileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError("profile failed schema validation", formatZodIssues(parsed.error));
  if (computeProfileHash(parsed.data) !== parsed.data.profileHash)
    throw new ValidationError("profile integrity check failed", [
      "the profile was modified after discovery (hash mismatch)",
    ]);
  return parsed.data;
}

/** `autonomous-plan`: regenerate the plan from a saved profile with exclusions (no new discovery). */
export async function cmdAutonomousPlan(
  io: CliIO,
  opts: ScopeFlags & { profile: string; output: string; parallel?: number; write?: string; runId?: string },
): Promise<number> {
  const profile = await loadProfile(io, opts.profile);
  const scope = resolveScope({
    mode: { mode: "autonomous", reasons: ["regenerated from a saved discovery profile"] },
    cli: toSelection(opts, opts.parallel),
  });
  const generated = generatePlan(profile, {
    selection: scope.selection,
    scopeRecord: scope.record,
    ...(opts.parallel ? { parallel: opts.parallel } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
  if ("error" in generated) {
    err(io, generated.error);
    return EXIT.INVALID;
  }
  const { testPlan, executionPlan } = generated.result;
  await atomicWriteFile(abs(io, opts.output), serializePlanYaml(testPlan));
  out(io, renderAutonomousReview(profile, testPlan, executionPlan));
  out(
    io,
    `Wrote ${opts.output} (${testPlan.scenarios.length} scenario(s), plan hash ${executionPlan.planHash})`,
  );
  if (opts.write) {
    await atomicWriteFile(abs(io, opts.write), `${stableStringify(executionPlan)}\n`);
    out(io, `Execution plan written to ${opts.write}`);
    out(
      io,
      `Approve with: browserswarm approve --plan ${opts.output} --profile ${opts.profile} --execution-plan ${opts.write}`,
    );
  }
  return EXIT.OK;
}
