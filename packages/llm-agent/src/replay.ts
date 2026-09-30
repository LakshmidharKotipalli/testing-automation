import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WorkPacket } from "@browserswarm/core";
import { GatewayBlocked, type GuardedBrowserSession, type RecordedCall } from "@browserswarm/mcp-gateway";
import type { Tool } from "@browserswarm/mcp-browser";
import { canonicalize, sha256 } from "@browserswarm/shared";

const RecordedCallSchema = z
  .object({
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    target: z.object({ role: z.string(), name: z.string() }).strict().optional(),
    urlAfter: z.string(),
  })
  .strict();

const ReplayEntrySchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string(),
    createdAt: z.string(),
    calls: z.array(RecordedCallSchema).min(1).max(500),
  })
  .strict();
export type ReplayEntry = z.infer<typeof ReplayEntrySchema>;

/**
 * Semantic fingerprint of an agentic mission. It covers what determines behavior (mission, scope, policy,
 * model, browser configuration, tool schemas and data references) and deliberately excludes run and packet
 * hashes, so a later run of the same approved mission finds the entry while any semantic change misses.
 */
export function replayFingerprint(packet: WorkPacket, tools: Tool[], testDataKeys: string[]): string {
  return sha256(
    canonicalize({
      v: 1,
      mission: {
        objective: packet.objective,
        instructions: packet.instructions ?? [],
        steps: packet.steps,
        expectedOutcome: packet.expectedOutcome,
        role: packet.role,
        viewport: packet.viewport,
      },
      scope: {
        targetUrl: packet.targetUrl,
        allowedDomains: [...packet.allowedDomains].sort(),
        allowSubdomains: packet.allowSubdomains,
      },
      policy: { agent: packet.agent, safety: packet.safety, llm: packet.llmPolicy },
      model: packet.model,
      browser: packet.browser,
      tools: tools
        .map((t) => ({ name: t.name, schema: sha256(canonicalize(t.inputSchema)) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      dataReferences: [...testDataKeys].sort(),
    }),
  );
}

/** Only successful, non-risky sequences are eligible: no approved risk, no elevated tool class, no secrets. */
export function replayEligible(packet: WorkPacket, gateway: GuardedBrowserSession): boolean {
  return (
    packet.mode === "agentic" &&
    packet.role !== "verifier" &&
    packet.replay?.enabled === true &&
    !packet.requiresExplicitRiskApproval &&
    packet.riskFlags.length === 0 &&
    gateway.recordable &&
    gateway.recording.length > 0
  );
}

export class ReplayCache {
  constructor(private readonly dir: string) {}
  private file(fingerprint: string): string {
    return path.join(this.dir, `${fingerprint.replace(/[^a-z0-9]/gi, "")}.json`);
  }
  async get(fingerprint: string): Promise<ReplayEntry | undefined> {
    try {
      const entry = ReplayEntrySchema.parse(JSON.parse(await readFile(this.file(fingerprint), "utf8")));
      return entry.fingerprint === fingerprint ? entry : undefined;
    } catch {
      return undefined;
    }
  }
  async put(fingerprint: string, calls: RecordedCall[], createdAt: string): Promise<void> {
    const entry = ReplayEntrySchema.parse({ version: 1, fingerprint, createdAt, calls });
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(fingerprint)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await rename(tmp, this.file(fingerprint));
  }
}

export interface ReplayOutcome {
  status: "complete" | "mismatch";
  replayed: number;
  total: number;
  reason?: string;
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/**
 * Replays a cached sequence through the same gateway the model uses, so every check (tool class, scope,
 * risk, budgets, challenge detection) runs again and fresh evidence is captured. Targets are re-resolved
 * from the current snapshot by role and accessible name; live refs are never stored. A safe mismatch stops
 * the replay so the model can take over; a policy violation is thrown and ends the packet.
 */
export async function replaySequence(
  gateway: GuardedBrowserSession,
  entry: ReplayEntry,
): Promise<ReplayOutcome> {
  let replayed = 0;
  const stop = (reason: string): ReplayOutcome => ({
    status: "mismatch",
    replayed,
    total: entry.calls.length,
    reason,
  });
  for (const call of entry.calls) {
    const args: Record<string, unknown> = { ...call.args };
    if (call.target) {
      await gateway.refresh();
      const matches = [...gateway.elements.values()].filter(
        (e) => e.role === call.target!.role && e.name === call.target!.name,
      );
      if (matches.length !== 1)
        return stop(
          `target_${matches.length ? "ambiguous" : "missing"}: ${call.target.role} "${call.target.name}"`,
        );
      args.ref = matches[0]!.ref;
    }
    try {
      const result = await gateway.callTool(call.tool, args, false);
      if (result.isError) return stop(`tool_error: ${call.tool}`);
    } catch (e) {
      /* Policy, scope, budget and challenge outcomes terminate the packet exactly as they would live. */
      if (e instanceof GatewayBlocked) throw e;
      return stop(`call_failed: ${call.tool}`);
    }
    if (pathOf(gateway.url) !== call.urlAfter) return stop(`unexpected_page: ${pathOf(gateway.url)}`);
    replayed++;
  }
  return { status: "complete", replayed, total: entry.calls.length };
}
