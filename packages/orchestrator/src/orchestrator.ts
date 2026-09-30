import { verifyApprovedPlan, type VerifiedApprovedPlan } from "@browserswarm/approval";
import type { BrowserLauncher } from "@browserswarm/browser-tools";
import type { SessionFactory } from "@browserswarm/mcp-browser";
import type { ChatClient } from "@browserswarm/opencode-adapter";
import {
  runStateMachine,
  TrackedState,
  type AgentEvent,
  type Finding,
  type PacketReport,
  type RunMetadata,
  type RunReport,
  type RunState,
  type TestPlan,
} from "@browserswarm/core";
import type { ReplacementAgentFactory } from "@browserswarm/handoff";
import { buildTestDataRedactor, resolveTestData } from "@browserswarm/policy-engine";
import { buildRunReport, writeReports } from "@browserswarm/reporters";
import { envSecrets, stableStringify, systemClock, type Clock } from "@browserswarm/shared";
import { EventStore, FilesystemStorage, RunLayout, type StorageAdapter } from "@browserswarm/storage";
import { PacketRunner, type PacketRunResult } from "./packet-runner.js";
import { Semaphore } from "./semaphore.js";

export interface RunOptions {
  /** Run directory (artifacts/{runId} by default). */
  outputDir: string;
  /** @deprecated Ignored; browser sessions are packet owned. */
  launcher?: BrowserLauncher;
  sessionFactory?: SessionFactory;
  modelClient?: ChatClient;
  signal?: AbortSignal;
  clock?: Clock;
  /** When supplied, approval is also checked against the current plan file (catches later edits). */
  currentPlan?: TestPlan;
  replacementFactory?: ReplacementAgentFactory;
  onEvent?: (event: AgentEvent) => void;
  env?: NodeJS.ProcessEnv;
  /** Pre-approval run states (DRAFT..PENDING_APPROVAL) recorded by the planning flow, for run.json history. */
  priorStateHistory?: RunMetadata["stateHistory"];
}

export interface RunResult {
  runId: string;
  outputDir: string;
  state: RunState;
  report: RunReport;
  reportFiles: string[];
  deferredReports: string[];
  exitCode: number;
}

/**
 * Executes an approved execution plan. The approval is verified before storage, browsers or agents are
 * touched; only the APPROVED -> RUNNING transition may initiate browser execution, and only the approved
 * work packets run.
 */
export async function executeApprovedPlan(approvedRaw: unknown, options: RunOptions): Promise<RunResult> {
  // 1. Verify first. Throws on any hash, approval or risk mismatch: nothing has been launched.
  const approved: VerifiedApprovedPlan = verifyApprovedPlan(
    approvedRaw,
    options.currentPlan ? { currentPlan: options.currentPlan } : {},
  );
  const ep = approved.executionPlan;
  if (ep.workPackets.some((p) => p.runtimeVersion !== "mcp-v1"))
    throw new Error("Execution runtime changed: preview and approve again for MCP execution");
  const clock = options.clock ?? systemClock;
  const testData = resolveTestData(ep.testData, ep.runId, options.env ?? process.env);
  // Test data and env-file secrets (the LLM API key) are masked in every artifact.
  const redactor = buildTestDataRedactor(testData, envSecrets(options.env ?? process.env));

  const storage: StorageAdapter = new FilesystemStorage(options.outputDir);
  const events = new EventStore(storage, ep.runId, RunLayout.events, clock);
  if (options.onEvent) events.onEvent(options.onEvent);

  const createdAt = clock.iso();
  const metadata: RunMetadata = {
    runId: ep.runId,
    state: "APPROVED",
    stateHistory: [
      ...(options.priorStateHistory ?? []),
      { state: "APPROVED", at: approved.approvalRecord.decidedAt },
    ],
    planId: ep.planId,
    planHash: ep.planHash,
    executionPlanHash: ep.executionPlanHash,
    approvalId: approved.approvalRecord.approvalId,
    outputDir: options.outputDir,
    createdAt,
    updatedAt: createdAt,
  };
  const writeRun = () => storage.writeJson(RunLayout.metadata.run, metadata);
  const runState = new TrackedState<RunState>(
    runStateMachine,
    "APPROVED",
    (from, to, reason) => {
      metadata.state = to;
      metadata.updatedAt = clock.iso();
      metadata.stateHistory.push(
        reason ? { state: to, at: metadata.updatedAt, reason } : { state: to, at: metadata.updatedAt },
      );
      events.emit({ type: "run.state.changed", data: { from, to, ...(reason ? { reason } : {}) } });
    },
    () => clock.iso(),
  );

  await storage.writeJson(RunLayout.metadata.executionPlan, ep);
  await storage.writeText(RunLayout.metadata.executionPlanHash, `${ep.executionPlanHash}\n`);
  await storage.writeJson(RunLayout.metadata.approvalRecord, approved.approvalRecord);
  await storage.writeText(RunLayout.metadata.approvedExecutionPlan, `${stableStringify(approved)}\n`);
  await writeRun();
  events.emit({
    type: "run.approved",
    data: {
      approvalId: approved.approvalRecord.approvalId,
      mode: approved.approvalRecord.mode,
      executionPlanHash: ep.executionPlanHash,
      riskAccepted: approved.approvalRecord.riskAccepted,
    },
  });

  // 2. APPROVED -> RUNNING is the only transition that starts browser work.
  const controller = new AbortController();
  const abortFrom = (reason: string) => {
    if (!controller.signal.aborted) {
      metadata.cancellationReason = reason;
      controller.abort(reason);
    }
  };
  options.signal?.addEventListener("abort", () => abortFrom("cancelled by user"), { once: true });
  const runTimer = setTimeout(
    () => abortFrom(`run timeout ${ep.concurrency.runTimeoutMs}ms reached`),
    ep.concurrency.runTimeoutMs,
  );

  runState.to("RUNNING");
  await writeRun();
  const startedAt = clock.iso();
  events.emit({
    type: "run.started",
    data: { packets: ep.workPackets.length, concurrency: ep.concurrency.maxConcurrentWorkPackets },
  });

  const results: PacketRunResult[] = [];
  const packetsById = new Map<string, PacketReport>();
  let infraError: string | undefined;
  let active = 0;
  let maxActive = 0;

  try {
    const semaphore = new Semaphore(ep.concurrency.maxConcurrentWorkPackets);
    const runners = ep.workPackets.map(
      (packet) =>
        new PacketRunner(packet, {
          storage,
          events,
          sessionFactory: options.sessionFactory,
          modelClient: options.modelClient,
          env: options.env,
          clock,
          approvedExecutionPlanHash: ep.executionPlanHash,
          riskApproved: approved.approvalRecord.riskAccepted,
          testData,
          redactor,
          signal: controller.signal,
          verifySeverityAtOrAbove: ep.reporting.verifySeverityAtOrAbove,
          ...(options.replacementFactory ? { replacementFactory: options.replacementFactory } : {}),
        }),
    );
    for (const runner of runners) await runner.queue();
    await Promise.all(
      runners.map((runner) =>
        semaphore.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            const result = await runner.run();
            results.push(result);
            packetsById.set(result.report.packetId, result.report);
            if (
              ep.concurrency.failFast &&
              (result.report.outcome === "failed" || result.report.outcome === "error")
            ) {
              abortFrom(`failFast: ${result.report.packetId} ${result.report.outcome}`);
            }
          } finally {
            active--;
          }
        }),
      ),
    );
  } catch (error) {
    infraError = (error as Error).message;
  } finally {
    clearTimeout(runTimer);
  }

  let finalState: RunState;
  if (infraError) {
    runState.to("FAILED", infraError);
    events.emit({ type: "run.failed", data: { error: redactor.redactString(infraError) } });
    finalState = "FAILED";
  } else if (controller.signal.aborted && !metadata.cancellationReason?.startsWith("failFast")) {
    runState.to("CANCELLED", metadata.cancellationReason);
    events.emit({ type: "run.cancelled", data: { reason: metadata.cancellationReason } });
    finalState = "CANCELLED";
  } else {
    runState.to("COMPLETED");
    events.emit({ type: "run.completed", data: { packets: results.length } });
    finalState = "COMPLETED";
  }
  await writeRun();

  // Deterministic ordering: approved packet order.
  const packets = ep.workPackets
    .map((p) => packetsById.get(p.packetId))
    .filter((p): p is PacketReport => !!p);
  const findings: Finding[] = results.flatMap((r) => r.findings);
  const endedAt = clock.iso();
  await events.flush();
  const report = buildRunReport({
    executionPlan: ep,
    approvalRecord: approved.approvalRecord,
    runState: finalState,
    packets,
    findings,
    startedAt,
    endedAt,
    generatedAt: endedAt,
    contextWarnings: results.reduce((n, r) => n + r.contextWarnings, 0),
    checkpointCount: results.reduce((n, r) => n + r.checkpoints, 0),
    llmCalls: packets.reduce((n, p) => n + (p.telemetry?.llmCalls ?? 0), 0),
    llmTokens: packets.reduce((n, p) => n + (p.telemetry?.tokens ?? 0), 0),
    modelsInvoked: [...new Set(packets.filter((p) => (p.telemetry?.llmCalls ?? 0) > 0).map((p) => p.model!))],
    maxObservedConcurrency: maxActive,
    packetsBlockedByHandoffLimit: results.filter((r) => r.blockedByHandoffLimit).length,
    packetsBlockedByCheckpointFailure: results.filter((r) => r.blockedByCheckpointFailure).length,
    ...(infraError
      ? { extraLimitations: [`Run failed before completion: ${redactor.redactString(infraError)}`] }
      : {}),
  });
  const written = await writeReports(storage, report, ep.reporting.formats);
  await events.flush();

  const anyFailed = packets.some((p) => p.outcome !== "passed");
  const exitCode = finalState === "COMPLETED" ? (anyFailed ? 1 : 0) : finalState === "CANCELLED" ? 130 : 1;
  return {
    runId: ep.runId,
    outputDir: options.outputDir,
    state: finalState,
    report,
    reportFiles: written.written.map((w) => storage.resolve(w)),
    deferredReports: written.deferred,
    exitCode,
  };
}
