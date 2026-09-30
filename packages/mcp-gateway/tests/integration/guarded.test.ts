import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { TestPlanSchema } from "@browserswarm/core";
import { generateExecutionPlan } from "@browserswarm/execution-planner";
import { McpBrowserSession } from "@browserswarm/mcp-browser";
import { createRedactor } from "@browserswarm/shared";
import { GuardedBrowserSession } from "../../src/index.js";
let server: Server,
  url: string,
  externalHits = 0,
  writes = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.host?.startsWith("localhost")) externalHits++;
    if (!["GET", "HEAD"].includes(req.method!)) writes++;
    const external = url.replace("127.0.0.1", "localhost");
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: external + "/outside" });
      res.end();
    } else if (req.url === "/resources")
      res.end(
        `<h1>Resources</h1><script src="${external}/evil.js"></script><img src="${external}/evil.png">`,
      );
    else if (req.url === "/challenge") res.end("<title>Just a moment</title><h1>Verify you are human</h1>");
    else if (req.url === "/writes")
      res.end(`<h1>Read only</h1><script>fetch('/write', {method:'POST',body:'no'});</script>`);
    else if (req.url === "/slow") {
      /* cancellation closes the pending request */
    } else res.end("<title>Owned fixture</title><h1>Ready</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function session(readOnly = false) {
  const packet = generateExecutionPlan(
    TestPlanSchema.parse({
      version: 1,
      id: "guard",
      name: "guard",
      target: { url, allowedDomains: ["127.0.0.1"] },
      scenarios: [
        {
          id: "s",
          title: "s",
          objective: "s",
          roles: ["functional"],
          viewports: ["desktop"],
          expectedOutcome: "Ready",
          steps: [{ action: "navigate", url: "/" }],
        },
      ],
    }),
  ).workPackets[0]!;
  const dir = await mkdtemp(path.join(os.tmpdir(), "bs-guard-real-"));
  const controller = new AbortController();
  const browser = new McpBrowserSession({ packet, artifactDir: dir, signal: controller.signal, readOnly });
  const gateway = new GuardedBrowserSession({
    packet,
    session: browser,
    artifactDir: dir,
    signal: controller.signal,
    redactor: createRedactor([]),
    deadline: Date.now() + 60000,
    riskApproved: false,
  });
  await browser.start();
  return { browser, gateway, dir, controller };
}
it("blocks cross-domain redirect hops before a request leaves scope", async () => {
  const s = await session(),
    before = externalHits;
  try {
    await expect(s.gateway.callTool("browser_navigate", { url: url + "/redirect" })).rejects.toThrow(
      /scope_exit/,
    );
    expect(externalHits).toBe(before);
    expect(await readFile(path.join(s.dir, "guard-ready.blocked"), "utf8")).toContain("localhost");
  } finally {
    await s.browser.close();
  }
});
it("blocks cross-domain subresources and retains trace evidence", async () => {
  const s = await session(),
    before = externalHits;
  try {
    await s.gateway.callTool("browser_navigate", { url: url + "/resources" });
    expect(externalHits).toBe(before);
    expect(await readFile(path.join(s.dir, "guard-ready.blocked"), "utf8")).toContain("evil.js");
  } finally {
    await s.browser.close();
  }
  expect((await readdir(s.dir, { recursive: true })).some((f) => String(f).endsWith(".trace"))).toBe(true);
});
it("returns BLOCKED for challenge pages with captured evidence", async () => {
  const s = await session();
  try {
    await expect(s.gateway.callTool("browser_navigate", { url: url + "/challenge" })).rejects.toThrow(
      "bot_protection_challenge",
    );
    expect(s.gateway.evidence.some((e) => e.type === "screenshot")).toBe(true);
  } finally {
    await s.browser.close();
  }
});
it("enforces read-only requests within the MCP server", async () => {
  const s = await session(true),
    before = writes;
  try {
    await s.gateway.callTool("browser_navigate", { url: url + "/writes" });
    expect(writes).toBe(before);
    expect(await readFile(path.join(s.dir, "guard-ready.blocked"), "utf8")).toContain('"method":"POST"');
  } finally {
    await s.browser.close();
  }
});
it("cancels a pending navigation and closes the owned server promptly", async () => {
  const s = await session();
  const start = Date.now();
  const call = s.gateway.callTool("browser_navigate", { url: url + "/slow" });
  const timer = setTimeout(() => s.controller.abort(), 100);
  try {
    await expect(call).rejects.toThrow();
    await s.browser.close();
    expect(Date.now() - start).toBeLessThan(8000);
  } finally {
    clearTimeout(timer);
    await s.browser.close();
  }
});
