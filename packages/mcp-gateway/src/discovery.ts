import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { checkUrl, parseSnapshot, type DomainScope, type SnapshotElement } from "@browserswarm/policy-engine";
import type { Redactor } from "@browserswarm/shared";
import type { BrowserSession, CallToolResult } from "@browserswarm/mcp-browser";
import { GatewayBlocked, toolText, detectChallenge } from "./guard-common.js";

/** The only MCP tools discovery may use. Everything else is denied, including evaluate and admin tools. */
export const DISCOVERY_TOOLS: readonly string[] = Object.freeze([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
]);

export interface DiscoveryBlock {
  url: string;
  method: string;
  kind: "external" | "non-read-method";
  reason: string;
  isNavigation: boolean;
  at: string;
}
export interface NetworkRecord {
  method: string;
  url: string;
  status?: number;
}
export interface ConsoleRecord {
  type: string;
  text: string;
}

export interface DiscoveryBrowserOptions {
  session: BrowserSession;
  scope: DomainScope;
  base: string;
  artifactDir: string;
  redactor: Redactor;
  signal: AbortSignal;
  /** Called with the tool name before each call; may throw to enforce budgets. */
  beforeCall?: (tool: string) => void;
  onBlocked?: (block: DiscoveryBlock) => void;
}

/**
 * Read-only discovery gateway over a packet-owned MCP session. Discovery has no model, but it uses the
 * same enforcement points as agentic execution: a tool allowlist, scope checks on every returned page URL,
 * challenge detection, redaction, path containment, a ledger, and request-layer blocking of non-GET/HEAD
 * and out-of-scope requests inside the MCP server (see `guardSource` with readOnly).
 */
export class DiscoveryBrowser {
  url = "about:blank";
  title = "";
  snapshotText = "";
  elements = new Map<string, SnapshotElement>();
  calls = 0;
  private blockedSeen = 0;
  constructor(private readonly o: DiscoveryBrowserOptions) {}

  private async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.o.signal.throwIfAborted();
    if (!DISCOVERY_TOOLS.includes(name)) throw new GatewayBlocked(`tool_not_allowed: ${name}`);
    this.o.beforeCall?.(name);
    this.calls++;
    const started = Date.now();
    let outcome = "passed";
    try {
      const result = await this.o.session.callTool(name, args);
      if (result.isError) outcome = "failed";
      return result;
    } catch (e) {
      outcome = "failed";
      throw e;
    } finally {
      await mkdir(this.o.artifactDir, { recursive: true });
      await appendFile(
        path.join(this.o.artifactDir, "tools.ndjson"),
        JSON.stringify({
          tool: name,
          args: this.o.redactor.redactValue(args),
          outcome,
          durationMs: Date.now() - started,
          timestamp: new Date().toISOString(),
        }) + "\n",
      );
    }
  }

  private observe(raw: string): void {
    const url = raw.match(/(?:Page URL:|URL:)\s*(https?:\/\/[^\s]+)/)?.[1];
    if (url) this.url = url;
    this.title = raw.match(/Page Title:\s*(.*)/)?.[1] ?? this.title;
    const snapshot = raw.match(/```yaml\n([\s\S]*?)```/)?.[1];
    if (snapshot !== undefined) {
      this.snapshotText = snapshot;
      this.elements = parseSnapshot(snapshot);
    }
    if (this.url !== "about:blank" && !checkUrl(this.url, this.o.base, this.o.scope).allowed)
      throw new GatewayBlocked("scope_exit");
    if (detectChallenge(this.title, this.snapshotText)) throw new GatewayBlocked("bot_protection_challenge");
  }

  /** Reads a fresh trusted snapshot; refs from earlier snapshots are never reused. */
  async snapshot(): Promise<string> {
    const result = await this.call("browser_snapshot", {});
    if (result.isError) throw new Error(`snapshot_failed: ${toolText(result).slice(0, 200)}`);
    this.observe(toolText(result));
    return this.snapshotText;
  }

  /** Navigates to an in-scope URL and reports the document's HTTP status when the network log has it. */
  async goto(raw: string): Promise<{ status?: number; url: string }> {
    const check = checkUrl(raw, this.o.base, this.o.scope);
    if (!check.allowed || !check.url) throw new GatewayBlocked(check.reason ?? "url_out_of_scope");
    const target = check.url;
    const result = await this.call("browser_navigate", { url: target });
    if (result.isError) {
      const text = toolText(result);
      throw new Error(
        text
          .split("\n")
          .find((l) => l.trim() && !l.startsWith("###"))
          ?.trim() ?? "navigation failed",
      );
    }
    this.observe(toolText(result));
    // A blocked main-document request is recorded by the in-server guard even if the page did not error.
    if ((await this.newBlocks()).some((b) => b.isNavigation)) throw new GatewayBlocked("scope_exit");
    const status = await this.documentStatus(target);
    return { ...(status !== undefined ? { status } : {}), url: this.url };
  }

  private async documentStatus(requested: string): Promise<number | undefined> {
    try {
      const rows = this.parseNetwork(
        toolText(await this.call("browser_network_requests", { includeStatic: true })),
      );
      const strip = (u: string) => u.replace(/#.*$/, "");
      const wanted = new Set([strip(requested), strip(this.url)]);
      const hit = [...rows].reverse().find((r) => r.method === "GET" && wanted.has(strip(r.url)));
      return hit?.status;
    } catch {
      return undefined;
    }
  }

  private parseNetwork(text: string): NetworkRecord[] {
    const rows: NetworkRecord[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\[([A-Z]+)\]\s+(\S+)(?:\s+=>\s+\[(\d+)\])?/);
      if (m) rows.push({ method: m[1]!, url: m[2]!, ...(m[3] ? { status: Number(m[3]) } : {}) });
    }
    return rows;
  }

  async network(): Promise<NetworkRecord[]> {
    return this.parseNetwork(toolText(await this.call("browser_network_requests", { includeStatic: true })));
  }

  async console(): Promise<ConsoleRecord[]> {
    const text = toolText(await this.call("browser_console_messages", { level: "warning" }));
    const rows: ConsoleRecord[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\[(ERROR|WARNING|WARN)\]\s+(.*)$/i);
      if (m) rows.push({ type: m[1]!.toLowerCase().startsWith("warn") ? "warning" : "error", text: m[2]! });
    }
    return rows;
  }

  /** Clicks a control by ref, but only when the ref still exists in the latest snapshot. */
  async click(ref: string, label: string): Promise<void> {
    const el = this.elements.get(ref);
    if (!el) throw new GatewayBlocked("stale_or_unresolved_target");
    const result = await this.call("browser_click", { element: label.slice(0, 200), ref });
    if (result.isError) throw new Error(toolText(result).slice(0, 200));
    this.observe(toolText(result));
    await this.newBlocks();
  }

  /** Types into a search box and submits. The request layer only lets GET/HEAD through. */
  async typeAndSubmit(ref: string, label: string, text: string): Promise<void> {
    if (!this.elements.has(ref)) throw new GatewayBlocked("stale_or_unresolved_target");
    const result = await this.call("browser_type", { element: label.slice(0, 200), ref, text, submit: true });
    if (result.isError) throw new Error(toolText(result).slice(0, 200));
    this.observe(toolText(result));
    await this.newBlocks();
  }

  /** Saves a viewport screenshot inside the packet directory. Returns the absolute path. */
  async screenshot(filename: string): Promise<string> {
    const root = path.resolve(this.o.artifactDir);
    const full = path.resolve(root, filename);
    if (!full.startsWith(root + path.sep) || filename.includes("\0"))
      throw new GatewayBlocked("artifact_path_outside_packet");
    const result = await this.call("browser_take_screenshot", { filename: full, type: "png" });
    if (result.isError) throw new Error(toolText(result).slice(0, 200));
    return full;
  }

  /** Blocked requests recorded by the in-server guard since the last call. */
  async newBlocks(): Promise<DiscoveryBlock[]> {
    let lines: string[];
    try {
      lines = (await readFile(path.join(this.o.artifactDir, "guard-ready.blocked"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const fresh = lines.slice(this.blockedSeen).map((l) => JSON.parse(l) as DiscoveryBlock);
    this.blockedSeen = lines.length;
    for (const b of fresh) this.o.onBlocked?.(b);
    return fresh;
  }
}
