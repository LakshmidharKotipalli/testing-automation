import { runIsolatedProcess } from "@browserswarm/opencode-adapter";
import type { ProcessOptions } from "@browserswarm/opencode-adapter";
/** Launch our own server; never ask the CLI to discover or start the user's managed service. */
export async function privateOpenCodeServer(options: Omit<ProcessOptions, "args" | "onLine" | "input">) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  let url = "",
    password = "";
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const running = runIsolatedProcess({
    ...options,
    signal,
    args: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    onLine(line) {
      url ||= line.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
      password ||= line.match(/server password (\S+)/)?.[1] ?? "";
      if (url && password) resolveReady();
    },
  });
  const close = async () => {
    controller.abort();
    await running.catch(() => undefined);
  };
  const startup = setTimeout(() => controller.abort("startup_deadline"), 15000);
  try {
    await Promise.race([
      ready,
      running.then(() => {
        throw new Error("opencode_server_exited");
      }),
    ]);
    clearTimeout(startup);
    const response = await fetch(url + "/api/config", {
      headers: { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error("opencode_configuration_unverified");
    const config: unknown = await response.json();
    // 2.0.19 returns source descriptors, not the effective merged permission/tool configuration.
    // Treat that as incompatible until an audited effective-config adapter is available.
    if (Array.isArray(config))
      throw new Error("opencode_compatibility: effective configuration unavailable (source list only)");
    return { url, password, config, close };
  } catch (error) {
    clearTimeout(startup);
    await close();
    throw error;
  }
}
