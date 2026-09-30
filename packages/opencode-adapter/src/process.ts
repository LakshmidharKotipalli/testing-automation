import { spawn } from "node:child_process";
export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onLine?: (line: string) => void;
}
export async function runIsolatedProcess(o: ProcessOptions): Promise<string> {
  o.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      lineBuffer = "",
      failure: Error | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already exited */
      }
    };
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 1000);
      force.unref();
    };
    const abort = () => stop(new Error("aborted"));
    o.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("process_timeout")), o.timeoutMs);
    child.stdout.on("data", (d) => {
      const text = d.toString();
      output += text;
      lineBuffer += text;
      if (output.length > 4000000) {
        stop(new Error("process_output_limit"));
        return;
      }
      for (let n; (n = lineBuffer.indexOf("\n")) >= 0;) {
        const line = lineBuffer.slice(0, n);
        lineBuffer = lineBuffer.slice(n + 1);
        try {
          o.onLine?.(line);
        } catch (e) {
          stop(e as Error);
        }
      }
    });
    child.stderr.resume(); // Never persist raw provider errors or credentials.
    child.on("error", (e) => {
      failure = e;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      o.signal?.removeEventListener("abort", abort);
      kill("SIGKILL");
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`process_exit_${code}`));
      else {
        try {
          if (lineBuffer) o.onLine?.(lineBuffer);
          resolve(output);
        } catch (e) {
          reject(e);
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
    if (o.signal?.aborted) abort();
  });
}
