import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { lstatSync } from "node:fs";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import {
  AgentPolicySchema,
  VerdictSchema,
  type Evidence,
  type Verdict,
  type WorkPacket,
} from "@browserswarm/core";
import {
  checkToolCall,
  checkUrl,
  parseSnapshot,
  TOOL_CLASSES,
  type SnapshotElement,
} from "@browserswarm/policy-engine";
import { newId, type Redactor } from "@browserswarm/shared";
import type { BrowserSession, Tool, CallToolResult } from "@browserswarm/mcp-browser";
export class GatewayBlocked extends Error {}
export function toolText(result: CallToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
export const VERDICT_TOOL: Tool = {
  name: "report_verdict",
  description: "Record the final verdict using captured evidence IDs for every expected outcome.",
  inputSchema: {
    type: "object",
    properties: {
      status: { enum: ["pass", "fail", "blocked", "inconclusive"] },
      summary: { type: "string" },
      outcomes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            expectedOutcome: { type: "string" },
            met: { type: "boolean" },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["expectedOutcome", "met", "evidence"],
          additionalProperties: false,
        },
      },
      failedStep: { type: ["integer", "null"] },
      observed: { type: "string" },
      expected: { type: "string" },
    },
    required: ["status", "summary", "outcomes"],
    additionalProperties: false,
  },
};
export interface GatewayOptions {
  packet: WorkPacket;
  session: BrowserSession;
  artifactDir: string;
  redactor: Redactor;
  signal: AbortSignal;
  deadline: number;
  riskApproved: boolean;
  resolveValue?: (value: string) => string;
}
export class GuardedBrowserSession {
  readonly evidence: Evidence[] = [];
  readonly ledger: Array<Record<string, unknown>> = [];
  verdict?: Verdict;
  url = "about:blank";
  title = "";
  snapshot = "";
  elements = new Map<string, SnapshotElement>();
  toolCalls = 0;
  blockedReason?: string;
  private readonly ajv = new Ajv({ strict: false });
  private readonly validators = new Map<string, ReturnType<Ajv["compile"]>>();
  constructor(readonly options: GatewayOptions) {}
  get tools(): Tool[] {
    const permitted = AgentPolicySchema.parse(this.options.packet.agent ?? {}).allowedTools;
    return [
      ...this.options.session.tools.filter(
        (t) =>
          TOOL_CLASSES[t.name] &&
          permitted.includes(TOOL_CLASSES[t.name]!) &&
          ![
            "browser_storage_state",
            "browser_set_storage_state",
            "browser_install",
            "browser_route",
            "browser_unroute",
            "browser_close",
            "browser_resize",
            "browser_tabs",
            "browser_press_key",
            "browser_handle_dialog",
          ].includes(t.name),
      ),
      VERDICT_TOOL,
    ];
  }
  private checkBudget(): void {
    this.options.signal.throwIfAborted();
    if (this.blockedReason) throw new GatewayBlocked(this.blockedReason);
    if (Date.now() >= this.options.deadline) throw new GatewayBlocked("packet_deadline");
    if (
      this.toolCalls >=
      Math.min(
        this.options.packet.actionBudget,
        AgentPolicySchema.parse(this.options.packet.agent ?? {}).maxToolCalls,
      )
    )
      throw new GatewayBlocked("tool_budget_exhausted");
    if (this.verdict) throw new GatewayBlocked("verdict_already_recorded");
  }
  private queue: Promise<unknown> = Promise.resolve();
  callTool(name: string, args: Record<string, unknown>, llmInvolved = true): Promise<CallToolResult> {
    const result = this.queue.then(() => this.executeTool(name, args, llmInvolved));
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    llmInvolved: boolean,
  ): Promise<CallToolResult> {
    const started = Date.now();
    let outcome = "passed";
    try {
      this.checkBudget();
      this.toolCalls++;
      if (name === "report_verdict") {
        const v = VerdictSchema.parse(args);
        if (v.outcomes.length !== 1 || v.outcomes[0]?.expectedOutcome !== this.options.packet.expectedOutcome)
          throw new Error("verdict must cover exactly the approved expectedOutcome");
        if (v.outcomes.some((o) => o.evidence.some((id) => !this.evidence.some((e) => e.evidenceId === id))))
          throw new Error("unknown verdict evidence");
        if (v.status === "pass" && v.outcomes.some((o) => !o.met || !o.evidence.length))
          throw new Error("pass requires evidence for every expected outcome");
        this.verdict = this.options.redactor.redactValue(v);
        return { content: [{ type: "text", text: "Verdict recorded" }] };
      }
      const tool = this.tools.find((t) => t.name === name);
      if (!tool) throw new GatewayBlocked(`tool_not_allowed: ${name}`);
      let validate = this.validators.get(name);
      if (!validate) {
        validate = this.ajv.compile(tool.inputSchema);
        this.validators.set(name, validate);
      }
      if (!validate(args)) throw new Error(`invalid_tool_arguments: ${this.ajv.errorsText(validate.errors)}`);
      if (TOOL_CLASSES[name] === "interact") await this.refresh();
      const decision = checkToolCall(
        name,
        args,
        { url: this.url, elements: this.elements, riskApproved: this.options.riskApproved },
        this.options.packet,
      );
      if (!decision.allowed) throw new GatewayBlocked(decision.reason);
      const forwarded = { ...args };
      if (this.options.resolveValue) {
        if (name === "browser_type" && typeof forwarded.text === "string")
          forwarded.text = this.options.resolveValue(forwarded.text);
        if (name === "browser_fill_form" && Array.isArray(forwarded.fields))
          forwarded.fields = forwarded.fields.map((f) => ({
            ...f,
            value: typeof f.value === "string" ? this.options.resolveValue!(f.value) : f.value,
          }));
      }
      if (name === "browser_navigate")
        forwarded.url = new URL(
          String(args.url),
          this.url === "about:blank" ? this.options.packet.targetUrl : this.url,
        ).href;
      if ("filename" in forwarded) forwarded.filename = this.safePath(String(forwarded.filename));
      if (name === "browser_file_upload") throw new GatewayBlocked("upload_source_not_approved");
      const result = await this.options.session.callTool(name, forwarded);
      if (name === "browser_snapshot" || /Page URL:|Snapshot/.test(toolText(result)))
        this.observe(toolText(result));
      // Every action gets a fresh authoritative URL and snapshot; model-provided labels are ignored.
      if (name !== "browser_snapshot") await this.refresh();
      await this.checkBlockedRequests();
      const text = this.options.redactor.redactString(toolText(result)).slice(0, 16000);
      const ev = await this.persistEvidence(
        name === "browser_console_messages"
          ? "console"
          : name === "browser_network_requests"
            ? "network"
            : "dom",
        text || this.snapshot,
      );
      if (name === "browser_take_screenshot" && !result.isError && typeof forwarded.filename === "string") {
        this.evidence.push({
          evidenceId: newId("ev"),
          type: "screenshot",
          path: forwarded.filename,
          summary: "Screenshot",
          createdAt: new Date().toISOString(),
        });
      }
      if (result.isError) {
        outcome = "failed";
        await this.captureFailure();
      }
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `${text}\nPage URL: ${this.url}\nPage Title: ${this.title}\n${this.snapshot}\nEvidence ID: ${ev.evidenceId}`,
          },
        ],
      };
    } catch (e) {
      outcome = e instanceof GatewayBlocked ? "blocked" : "failed";
      if (e instanceof GatewayBlocked) this.blockedReason = e.message;
      await this.captureFailure().catch(() => undefined);
      throw e;
    } finally {
      const row = {
        tool: name,
        args: this.options.redactor.redactValue(args),
        outcome,
        durationMs: Date.now() - started,
        llmInvolved,
        timestamp: new Date().toISOString(),
      };
      this.ledger.push(row);
      await mkdir(this.options.artifactDir, { recursive: true });
      await appendFile(path.join(this.options.artifactDir, "tools.ndjson"), JSON.stringify(row) + "\n");
    }
  }
  safePath(filename: string): string {
    const root = path.resolve(this.options.artifactDir);
    const full = path.resolve(root, filename);
    if (!full.startsWith(root + path.sep) || filename.includes("\0"))
      throw new GatewayBlocked("artifact_path_outside_packet");
    // Reject symlinked ancestors, including the final filename, before handing a path to MCP.
    let current = full;
    while (current !== root) {
      try {
        if (lstatSync(current).isSymbolicLink()) throw new GatewayBlocked("artifact_symlink_blocked");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      current = path.dirname(current);
    }
    return full;
  }
  observe(raw: string): void {
    const url = raw.match(/(?:Page URL:|URL:)\s*(https?:\/\/[^\s]+)/)?.[1];
    if (url) this.url = url;
    this.title = raw.match(/Page Title:\s*(.*)/)?.[1] ?? this.title;
    const snapshot = raw.match(/```yaml\n([\s\S]*?)```/)?.[1] ?? raw;
    this.snapshot = this.options.redactor.redactString(snapshot).slice(0, 16000);
    this.elements = parseSnapshot(snapshot);
    if (
      this.url !== "about:blank" &&
      !checkUrl(this.url, this.options.packet.targetUrl, this.options.packet).allowed
    )
      throw new GatewayBlocked("scope_exit");
    if (
      /just a moment|verify (?:that )?you are human|checking your browser|performing security verification|cf-chl-/i.test(
        this.title + "\n" + snapshot,
      )
    )
      throw new GatewayBlocked("bot_protection_challenge");
  }
  async refresh(): Promise<void> {
    const result = await this.options.session.callTool("browser_snapshot", {});
    if (result.isError) throw new GatewayBlocked("trusted_snapshot_unavailable");
    this.observe(toolText(result));
  }
  private async checkBlockedRequests(): Promise<void> {
    try {
      const lines = (await readFile(path.join(this.options.artifactDir, "guard-ready.blocked"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (lines.some((line) => JSON.parse(line).isNavigation)) throw new GatewayBlocked("scope_exit");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  async persistEvidence(type: Evidence["type"], text: string): Promise<Evidence> {
    const id = newId("ev");
    const file = this.safePath(`${id}.txt`);
    await mkdir(this.options.artifactDir, { recursive: true });
    await writeFile(file, this.options.redactor.redactString(text).slice(0, 16000));
    const ev: Evidence = {
      evidenceId: id,
      type,
      path: file,
      summary: `${type} at ${this.options.redactor.redactString(this.url)}`.slice(0, 4000),
      createdAt: new Date().toISOString(),
    };
    this.evidence.push(ev);
    return ev;
  }
  async captureFailure(): Promise<void> {
    if (this.snapshot) await this.persistEvidence("dom", this.snapshot);
    for (const [name, type] of [
      ["browser_console_messages", "console"],
      ["browser_network_requests", "network"],
    ] as const) {
      if (!this.options.session.tools.some((t) => t.name === name)) continue;
      try {
        await this.persistEvidence(type, toolText(await this.options.session.callTool(name, {})));
      } catch {
        /* capture is best effort */
      }
    }
    if (this.options.session.tools.some((t) => t.name === "browser_take_screenshot")) {
      const filename = this.safePath(`${newId("failure")}.png`);
      try {
        const result = await this.options.session.callTool("browser_take_screenshot", {
          filename,
          type: "png",
        });
        if (!result.isError)
          this.evidence.push({
            evidenceId: newId("ev"),
            type: "screenshot",
            path: filename,
            summary: "Failure screenshot",
            createdAt: new Date().toISOString(),
          });
      } catch {
        /* capture is best effort */
      }
    }
  }
}
export * from "./scripted.js";
export * from "./bridge.js";
