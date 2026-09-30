import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkPacket } from "@browserswarm/core";
import { checkUrl } from "@browserswarm/policy-engine";
import { processHost } from "./process-host.js";
import { guardSource } from "./request-guard.js";
export type { Tool, CallToolResult };
export const MCP_VERSION = "0.0.68";
export interface BrowserSession {
  tools: Tool[];
  start(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  saveStorage(filename: string): Promise<boolean>;
  close(): Promise<void>;
}
export interface SessionOptions {
  packet: WorkPacket;
  artifactDir: string;
  signal: AbortSignal;
  storageState?: string;
  readOnly?: boolean;
  executablePath?: string;
}
export type SessionFactory = (options: SessionOptions) => BrowserSession;
export class McpBrowserSession implements BrowserSession {
  tools: Tool[] = [];
  private readonly client = new Client({ name: "browserswarm", version: "1.0.0" });
  private transport?: StdioClientTransport;
  private closing?: Promise<void>;
  private readonly abort = () => {
    void this.close();
  };
  constructor(private readonly options: SessionOptions) {}
  async start(): Promise<void> {
    const o = this.options;
    o.signal.throwIfAborted();
    if (o.packet.browser.engine !== "chromium") throw new Error("Only Chromium and Chrome are supported");
    const root = path.resolve(o.artifactDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const ready = path.join(root, "guard-ready");
    await rm(ready, { force: true });
    await rm(ready + ".blocked", { force: true });
    const guard = path.join(root, "request-guard.cjs");
    await writeFile(guard, guardSource(o.packet, ready, !!o.readOnly), { mode: 0o600 });
    const config = {
      browser: {
        browserName: "chromium",
        isolated: !o.packet.browser.persistentProfile,
        ...(o.packet.browser.persistentProfile ? { userDataDir: path.join(root, "profile") } : {}),
        launchOptions: {
          headless: o.packet.browser.headless,
          ...(o.packet.browser.channel === "chrome" ? { channel: "chrome" } : { channel: "chromium" }),
          ...(o.executablePath ? { executablePath: o.executablePath } : {}),
        },
        contextOptions: {
          viewport: o.packet.viewport,
          locale: o.packet.browser.locale,
          timezoneId: o.packet.browser.timezoneId,
          serviceWorkers: "block",
          acceptDownloads: false,
          ...(o.storageState ? { storageState: o.storageState } : {}),
        },
        initPage: [guard],
      },
      capabilities: ["core", "storage"],
      outputDir: root,
      saveTrace: o.packet.browser.trace,
      snapshot: { mode: "full" },
      codegen: "none",
      timeouts: {
        action: o.packet.browser.actionTimeoutMs,
        navigation: o.packet.browser.navigationTimeoutMs,
      },
    };
    const configPath = path.join(root, "mcp-config.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
    // Deliberately do not pass provider credentials or inherited MCP configuration to the browser.
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH"])
      if (process.env[key]) env[key] = process.env[key]!;
    const hostPath = path.join(root, "mcp-host.cjs");
    await writeFile(hostPath, processHost, { mode: 0o600 });
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [hostPath, cli, "--config", configPath],
      cwd: root,
      env,
      stderr: "pipe",
    });
    o.signal.addEventListener("abort", this.abort, { once: true });
    try {
      await this.client.connect(this.transport, { timeout: 30000 });
      await this.client.ping({ timeout: 5000 });
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
        this.tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 32)) throw new Error("invalid_tool_pagination");
        if (cursor) seen.add(cursor);
      } while (cursor);
      const initial = await this.callTool("browser_snapshot", {});
      if (initial.isError) throw new Error(JSON.stringify(initial.content));
      // The upstream server logs init-hook exceptions. Verify the hook actually installed.
      if ((await readFile(ready, "utf8")) !== o.packet.workPacketHash)
        throw new Error("request_guard_unavailable");
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.options.signal.throwIfAborted();
    if (!this.tools.some((t) => t.name === name)) throw new Error(`MCP tool unavailable: ${name}`);
    return (await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: Math.min(
        this.options.packet.timeoutMs,
        this.options.packet.browser.navigationTimeoutMs + 5000,
      ),
      signal: this.options.signal,
    })) as CallToolResult;
  }
  async saveStorage(filename: string): Promise<boolean> {
    if (!this.tools.some((t) => t.name === "browser_storage_state")) return false;
    const full = path.resolve(filename);
    if (!full.startsWith(path.resolve(this.options.artifactDir) + path.sep)) return false;
    const result = await this.callTool("browser_storage_state", { filename: full });
    if (result.isError) return false;
    const state = JSON.parse(await readFile(full, "utf8"));
    state.cookies = (state.cookies ?? []).filter(
      (c: { domain: string }) =>
        checkUrl(`https://${c.domain.replace(/^\./, "")}`, this.options.packet.targetUrl, this.options.packet)
          .allowed,
    );
    state.origins = (state.origins ?? []).filter(
      (v: { origin: string }) =>
        checkUrl(v.origin, this.options.packet.targetUrl, this.options.packet).allowed,
    );
    await writeFile(full, JSON.stringify(state), { mode: 0o600 });
    return true;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.options.signal.removeEventListener("abort", this.abort);
      if (this.tools.some((t) => t.name === "browser_close"))
        await this.client
          .callTool({ name: "browser_close", arguments: {} }, undefined, { timeout: 2000 })
          .catch(() => undefined);
      await this.client.close().catch(() => undefined);
      await this.transport?.close().catch(() => undefined);
    })());
  }
}
