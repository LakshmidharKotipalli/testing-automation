import { it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runIsolatedProcess } from "@browserswarm/opencode-adapter";
import { assertIsolatedConfig } from "../src/opencode-driver.js";
it("rejects effective configs with global MCPs, built-ins or plugins", () => {
  const valid = {
    permission: { "*": "deny", "browserswarm_*": "allow" },
    mcp: { browserswarm: { enabled: true } },
    plugin: [],
  };
  expect(() => assertIsolatedConfig(valid)).not.toThrow();
  expect(() => assertIsolatedConfig({ ...valid, mcp: { ...valid.mcp, global: { enabled: true } } })).toThrow(
    /extra_mcp/,
  );
  expect(() =>
    assertIsolatedConfig({ ...valid, permission: { ...valid.permission, bash: "allow" } }),
  ).toThrow(/extra_permissions/);
  expect(() => assertIsolatedConfig({ ...valid, plugin: ["unsafe"] })).toThrow(/plugins/);
});
it("kills a fake executable upon a foreign-tool event", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bs-opencode-fake-"));
  const file = path.join(cwd, "fake.cjs");
  await writeFile(
    file,
    `console.log(JSON.stringify({type:'tool_use',part:{tool:'bash'}}));setInterval(()=>{},1000);`,
  );
  await expect(
    runIsolatedProcess({
      command: process.execPath,
      args: [file],
      cwd,
      env: {},
      timeoutMs: 10000,
      onLine: (line) => {
        const e = JSON.parse(line);
        if (!e.part.tool.startsWith("browserswarm_")) throw new Error("policy_violation");
      },
    }),
  ).rejects.toThrow(/policy_violation/);
});
it("terminates on timeout and abort", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bs-opencode-stop-"));
  const opts = {
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd,
    env: {},
    timeoutMs: 50,
  };
  await expect(runIsolatedProcess(opts)).rejects.toThrow(/timeout/);
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await expect(runIsolatedProcess({ ...opts, timeoutMs: 10000, signal: c.signal })).rejects.toThrow(
    /aborted/,
  );
});
