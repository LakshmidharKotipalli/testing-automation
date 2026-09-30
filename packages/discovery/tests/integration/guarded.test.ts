import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserConfigSchema, ContextPolicySchema, DiscoveryPolicySchema } from "@browserswarm/core";
import { createRedactor } from "@browserswarm/shared";
import { EventStore, FilesystemStorage, RunLayout } from "@browserswarm/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiscoveryPacket, DiscoveryLeadAgent, recordDiscoveryAuthorization } from "../../src/index.js";

let server: ReturnType<typeof createServer>;
let url = "";
const requests: Array<{ method: string; path: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "" });
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/challenge")) {
      res.end("<title>Just a moment...</title><h1>Checking your browser before accessing</h1>");
    } else if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "http://external.invalid/");
      res.end();
    } else if (req.url === "/") {
      res.end(
        '<title>Home</title><h1>Home</h1><a href="/redirect">Away</a>' +
          '<form method="post" action="/write"><input name="q"><button>Save</button></form>',
      );
    } else res.end("<title>x</title><h1>x</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function run(entry: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "bs-disc-guard-"));
  const storage = new FilesystemStorage(dir);
  const events = new EventStore(storage, "run-guard", RunLayout.discovery.events);
  const packet = createDiscoveryPacket(
    {
      targetUrl: `${url}${entry}`,
      allowedDomains: ["127.0.0.1"],
      mode: "autonomous",
      discoveryPolicy: DiscoveryPolicySchema.parse({ maxDurationMs: 60_000, maxScreenshots: 0 }),
      browser: BrowserConfigSchema.parse({ trace: false }),
      contextLifecycle: ContextPolicySchema.parse({}),
    },
    "run-guard",
  );
  const agent = new DiscoveryLeadAgent(packet, { storage, events, redactor: createRedactor() });
  return agent.run(recordDiscoveryAuthorization({ packet, operator: "vitest", mode: "noninteractive" }));
}

describe("discovery through the guarded MCP session", () => {
  it("stops with bot_protection_challenge when the entry page is a challenge", async () => {
    const result = await run("/challenge");
    expect(result.status).toBe("blocked");
    expect(result.stopReason).toMatch(/bot_protection_challenge/);
  }, 60000);

  it("never follows an out-of-scope redirect and sends no writes", async () => {
    requests.length = 0;
    const result = await run("/");
    expect(result.observations.some((o) => o.path === "/redirect")).toBe(true);
    expect(requests.filter((r) => r.method !== "GET" && r.method !== "HEAD")).toEqual([]);
    expect(result.restricted.some((r) => r.kind === "form")).toBe(true);
    expect(result.observations.find((o) => o.path === "/redirect")?.status).not.toBe("visited");
  }, 90000);
});
