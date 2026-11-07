import { z } from "zod";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { connectHostedSession } from "../lib/development/hosted-session-client.ts";

const { values } = parseArgs({
  options: {
    "codex-bin": { type: "string" },
    cwd: { type: "string" },
    "resource-url": { type: "string" },
  },
});
if (
  values["codex-bin"] === undefined ||
  values["resource-url"] === undefined ||
  values.cwd === undefined
) {
  throw new Error(
    "Required: --codex-bin <absolute path> --resource-url <HTTPS /mcp URL> --cwd <private state directory>",
  );
}
const cancellation = new AbortController();
process.once("SIGTERM", () => {
  cancellation.abort();
});
process.once("SIGINT", () => {
  cancellation.abort();
});
const upstream = await connectHostedSession({
  codexBin: values["codex-bin"],
  cwd: values.cwd,
  resourceUrl: values["resource-url"],
  signal: cancellation.signal,
});
const handle = serveStdio(
  () => {
    // oxlint-disable-next-line typescript/no-deprecated -- Low-level forwarding preserves the upstream tool schemas without recreating local tools.
    const server = new Server(
      { name: "autograph-hosted-session-connector", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "Calls execute in the existing hosted Builder session through the official Codex MCP connection. This adapter does not execute the local Builder agent.",
      },
    );
    server.setRequestHandler("tools/list", () => ({ tools: upstream.tools }));
    server.setRequestHandler("tools/call", async (request) => {
      const result = await upstream.call(
        request.params.name,
        z.record(z.string(), z.json()).parse(request.params.arguments ?? {}),
        request.params._meta === undefined
          ? undefined
          : z.record(z.string(), z.json()).parse(request.params._meta),
      );
      return server.projectCallToolResult(
        result,
        upstream.tools.find((tool) => tool.name === request.params.name)?.outputSchema,
      );
    });
    return server;
  },
  {
    onerror: () => {
      /* Never log upstream messages or credential-bearing data. */
    },
  },
);
let closing = false;
const close = async () => {
  if (closing) {
    return;
  }
  closing = true;
  await handle.close();
  await upstream.close();
};
process.stdin.once("end", () => {
  void close();
});
cancellation.signal.addEventListener(
  "abort",
  () => {
    void close();
  },
  { once: true },
);
