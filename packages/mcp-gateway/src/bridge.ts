import net from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GuardedBrowserSession } from "./index.js";
/** A Unix-domain endpoint owned by the parent. The stdio wrapper contains no policy state. */
export async function createGatewayBridge(
  gateway: GuardedBrowserSession,
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bs-ipc-"));
  await chmod(dir, 0o700);
  const socketPath = path.join(dir, "gateway.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 128000) {
        socket.destroy();
        return;
      }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = "";
      void (async () => {
        try {
          const request = JSON.parse(line);
          const result =
            request.method === "list"
              ? gateway.tools
              : request.method === "call"
                ? await gateway.callTool(request.name, request.args)
                : (() => {
                    throw new Error("invalid bridge method");
                  })();
          socket.end(JSON.stringify({ result }) + "\n");
        } catch (e) {
          socket.end(
            JSON.stringify({ error: gateway.options.redactor.redactString((e as Error).message) }) + "\n",
          );
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
