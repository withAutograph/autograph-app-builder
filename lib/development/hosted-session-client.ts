/* oxlint-disable eslint/no-await-in-loop -- Startup reads must observe the same initialized thread sequentially. */
/* oxlint-disable promise/avoid-new -- Native child JSON-RPC and process close events require explicit promise bridges. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { isCallToolResult } from "@modelcontextprotocol/server";
import type { CallToolResult, Tool, JSONValue, JSONObject } from "@modelcontextprotocol/server";
import { z } from "zod";

export const hostedSessionTools = [
  "autograph_start",
  "autograph_get",
  "autograph_send",
  "autograph_respond",
  "autograph_cancel",
] as const;
const serverName = "a511-original";
const toolSchema = z.looseObject({
  name: z.string(),
  inputSchema: z.looseObject({ type: z.literal("object") }),
});
const statusSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullable(),
      httpOrigin: z.string().nullable(),
      toolsError: z.string().nullable(),
      tools: z.record(z.string(), toolSchema),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const failure = () =>
  new Error(
    "Native hosted Builder transport failed; reconcile the existing request before retrying.",
  );

const validateInput = (input: { codexBin: string; resourceUrl: string; cwd: string }) => {
  let url: URL;
  try {
    url = new URL(input.resourceUrl);
  } catch {
    throw new Error("Hosted Builder resource must be a credential-free HTTPS /mcp URL.");
  }
  if (
    ![
      url.protocol === "https:",
      !url.username,
      !url.password,
      url.pathname === "/mcp",
      !url.search,
      !url.hash,
    ].every(Boolean)
  ) {
    throw new Error("Hosted Builder resource must be a credential-free HTTPS /mcp URL.");
  }
  if (!path.isAbsolute(input.cwd) || !path.isAbsolute(input.codexBin)) {
    throw new Error("Native connector paths must be absolute.");
  }
  for (let ancestor = input.cwd; ; ancestor = path.dirname(ancestor)) {
    if (existsSync(path.join(ancestor, ".git"))) {
      throw new Error("Native connector state must be outside repository directories.");
    }
    if (path.dirname(ancestor) === ancestor) {
      break;
    }
  }
  return url;
};

const verifyOrigin = (origin: string | null | undefined, expected: string) => {
  if (origin !== undefined && origin !== null && origin !== expected) {
    throw failure();
  }
};

/** Uses the official client's existing canonical MCP connection. Never reads credentials or runs a model turn. */
export const connectHostedSession = async (input: {
  codexBin: string;
  resourceUrl: string;
  cwd: string;
  signal?: AbortSignal;
}) => {
  input.signal?.throwIfAborted();
  const url = validateInput(input);
  const directory = await mkdtemp(path.join(input.cwd, "builder-native-mcp-"));
  await chmod(directory, 0o700);
  const child = spawn(
    input.codexBin,
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'plugins."app-builder@autograph-dev".enabled=false',
      "-c",
      'plugins."app-builder@autograph".enabled=false',
      "-c",
      `mcp_servers.${serverName}.url=${JSON.stringify(url.href)}`,
      "-c",
      `mcp_servers.${serverName}.oauth_resource=${JSON.stringify(url.href)}`,
      "-c",
      `mcp_servers.${serverName}.enabled=true`,
    ],
    { cwd: directory, stdio: ["pipe", "pipe", "ignore"] },
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (value: JSONValue | undefined) => void; reject: (reason: Error) => void }
  >();
  let sequence = 0;
  let closed = false;
  let terminated = false;
  const failPending = () => {
    for (const request of pending.values()) {
      request.reject(failure());
    }
    pending.clear();
  };
  child.on("error", () => {
    terminated = true;
    failPending();
  });
  child.on("close", () => {
    terminated = true;
    failPending();
  });
  child.stdin.on("error", failPending);
  const send = (value: JSONValue) => child.stdin.write(`${JSON.stringify(value)}\n`);
  lines.on("line", (line) => {
    try {
      const message = z
        .looseObject({
          id: z.union([z.number(), z.string()]).optional(),
          method: z.string().optional(),
          result: z.json().optional(),
          error: z.json().optional(),
        })
        .parse(JSON.parse(line));
      if (message.method !== undefined && message.id !== undefined) {
        // Never synthesize consent, attestation, credentials or user answers.
        send({
          id: message.id,
          error: {
            code: -32_601,
            message: "Interactive native requests require the ordinary Codex client.",
          },
        });
      } else if (z.number().safeParse(message.id).success) {
        const request = pending.get(Number(message.id));
        pending.delete(Number(message.id));
        if (message.error === undefined) {
          request?.resolve(message.result);
        } else {
          request?.reject(failure());
        }
      }
    } catch {
      failPending();
    }
  });
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
  const rpc = (method: string, params: JSONValue) =>
    new Promise<JSONValue | undefined>((resolve, reject) => {
      if (closed || terminated || child.exitCode !== null || child.killed) {
        reject(failure());
        return;
      }
      sequence += 1;
      const id = sequence;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(failure());
        },
        method === "mcpServer/tool/call" ? 1_800_000 : 120_000,
      );
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  const closeChild = async () => {
    if (closed) {
      return;
    }
    closed = true;
    // oxlint-disable-next-line eslint/no-use-before-define -- The close/abort callbacks share one idempotent cleanup promise.
    input.signal?.removeEventListener("abort", abort);
    failPending();
    child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      if (terminated || child.exitCode !== null || child.signalCode !== null) {
        resolve();
      } else {
        child.once("close", () => {
          resolve();
        });
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 1000);
    const force = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3000);
    await exited;
    clearTimeout(timer);
    clearTimeout(force);
    lines.close();
    await rm(directory, { recursive: true, force: true });
  };
  let closing: Promise<void> | undefined;
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
  const close = () => {
    closing ??= closeChild();
    return closing;
  };
  const abort = () => {
    void close();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    input.signal?.throwIfAborted();
    await rpc("initialize", {
      clientInfo: { name: "autograph_local_hosted_connector", version: "1.0.0" },
    });
    send({ method: "initialized" });
    const thread = z
      .object({ thread: z.object({ id: z.string() }) })
      .parse(await rpc("thread/start", { cwd: directory, ephemeral: true }));
    let tools: Tool[] = [];
    const readyDeadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() >= readyDeadline) {
        throw failure();
      }
      const status = statusSchema.parse(
        await rpc("mcpServerStatus/list", {
          threadId: thread.thread.id,
          serverName,
          detail: "toolsAndAuthOnly",
        }),
      );
      const upstream = status.data.find((entry) => entry.name === serverName);
      verifyOrigin(upstream?.httpOrigin, url.origin);
      if (upstream?.runtimeStatus === "connected" && upstream.toolsError === null) {
        if (upstream.httpOrigin !== url.origin) {
          throw failure();
        }
        tools = Object.values(upstream.tools).filter((tool) =>
          hostedSessionTools.some((name) => name === tool.name),
        );
        if (
          tools.length !== hostedSessionTools.length ||
          new Set(tools.map((tool) => tool.name)).size !== tools.length
        ) {
          throw failure();
        }
        break;
      }
      if (upstream?.runtimeStatus === "authenticationRequired") {
        throw new Error(
          "Sign in through the official Codex client using codex mcp login a511-original, then reconnect. No Builder tool was submitted.",
        );
      }
      if (
        upstream !== undefined &&
        !["notStarted", "starting"].includes(upstream.runtimeStatus ?? "notStarted")
      ) {
        throw failure();
      }
      await delay(100);
    }
    return {
      tools,
      async call(name: string, args: JSONObject, meta?: JSONObject): Promise<CallToolResult> {
        if (!hostedSessionTools.some((tool) => tool === name)) {
          throw new Error("Only the five public Builder tools are supported.");
        }
        const params: JSONObject = {
          threadId: thread.thread.id,
          server: serverName,
          tool: name,
          arguments: args,
        };
        if (meta !== undefined) {
          params._meta = meta;
        }
        const result = await rpc("mcpServer/tool/call", params);
        if (!isCallToolResult(result)) {
          throw failure();
        }
        return result;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};
