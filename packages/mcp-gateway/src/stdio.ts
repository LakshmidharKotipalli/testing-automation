import net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const socketPath = process.env.BROWSERSWARM_GATEWAY_SOCKET;
if (!socketPath) throw new Error("Missing parent gateway socket");
async function rpc(request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath!);
    let buffer = "";
    socket.setTimeout(65000, () => socket.destroy(new Error("gateway timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1000000) socket.destroy(new Error("gateway response too large"));
    });
    socket.on("end", () => {
      try {
        const value = JSON.parse(buffer);
        if (value.error) reject(new Error(value.error));
        else resolve(value.result);
      } catch (e) {
        reject(e);
      }
    });
  });
}
const server = new Server({ name: "browserswarm", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await rpc({ method: "list" }) }));
server.setRequestHandler(CallToolRequestSchema, async (r) => {
  try {
    return (await rpc({ method: "call", name: r.params.name, args: r.params.arguments ?? {} })) as {
      content: [];
    };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
  }
});
await server.connect(new StdioServerTransport());
