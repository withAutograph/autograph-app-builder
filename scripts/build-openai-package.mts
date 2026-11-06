import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { codexClientId, codexRedirectUri } from "../lib/auth/codex-client-metadata.ts";
import { formatWithOxfmt } from "./format-with-oxfmt.mts";
import {
  assertAutographMcpEndpoint,
  AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT,
  AUTOGRAPH_MCP_SERVER_NAME,
  AUTOGRAPH_PACKAGE_VERSION,
} from "../lib/plugin/agent-plugin-package.ts";

const portableSchema = z.object({
  author: z.object({ name: z.string(), url: z.string().optional() }),
  description: z.string(),
  homepage: z.string(),
  keywords: z.array(z.string()),
  license: z.string(),
  name: z.string(),
  repository: z.string(),
  version: z.string(),
});
const portable = portableSchema.parse(
  JSON.parse(await readFile(path.resolve("plugin.json"), "utf-8")),
);
const connectionIndex = process.argv.indexOf("--connection-id");
const connectionId =
  connectionIndex === -1 ? undefined : z.string().parse(process.argv[connectionIndex + 1]);
const endpointIndex = process.argv.indexOf("--endpoint");
const suppliedEndpoint =
  endpointIndex === -1 ? undefined : z.string().parse(process.argv[endpointIndex + 1]);
const endpoint =
  suppliedEndpoint ??
  (connectionId !== undefined && connectionId.length > 0
    ? undefined
    : AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT);

if (connectionIndex === -1 || (connectionId !== undefined && connectionId.length > 0)) {
  // The option is absent or has a value.
} else {
  throw new Error("Missing value for --connection-id.");
}
if (endpointIndex === -1 || (suppliedEndpoint !== undefined && suppliedEndpoint.length > 0)) {
  // The option is absent or has a value.
} else {
  throw new Error("Missing value for --endpoint.");
}

if (
  connectionId !== undefined &&
  connectionId.length > 0 &&
  suppliedEndpoint !== undefined &&
  suppliedEndpoint.length > 0
) {
  throw new Error("Pass either --connection-id or --endpoint, not both.");
}

if (portable.version !== AUTOGRAPH_PACKAGE_VERSION) {
  throw new Error(`plugin.json version must be exactly ${AUTOGRAPH_PACKAGE_VERSION}.`);
}

if (suppliedEndpoint !== undefined && suppliedEndpoint.length > 0) {
  assertAutographMcpEndpoint(suppliedEndpoint, { release: true });
}

const portableMcpPath = path.resolve("mcp.json");
const portableMcpSchema = z.object({
  mcpServers: z.record(z.string(), z.object({ type: z.string(), url: z.string() })).optional(),
});
const portableMcp = portableMcpSchema.parse(JSON.parse(await readFile(portableMcpPath, "utf-8")));
const portableServerNames = Object.keys(portableMcp.mcpServers ?? {});
if (portableServerNames.length !== 1 || portableServerNames[0] !== AUTOGRAPH_MCP_SERVER_NAME) {
  throw new Error(`mcp.json must declare exactly one ${AUTOGRAPH_MCP_SERVER_NAME} MCP server.`);
}
const portableServer = portableMcp.mcpServers[AUTOGRAPH_MCP_SERVER_NAME];
if (portableServer === undefined || portableServer.type !== "streamable-http") {
  throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`);
}
assertAutographMcpEndpoint(portableServer.url, { release: false });

const manifest = {
  author: portable.author,
  description: portable.description,
  homepage: portable.homepage,
  interface: {
    brandColor: "#111827",
    capabilities: ["Interactive", "Read", "Write"],
    category: "Developer Tools",
    composerIcon: "./assets/autograph-icon.png",
    defaultPrompt: [
      "Create an app for [who it is for, what they need to do, and the outcome you want]",
      "Build an event planning app for coordinating guests, schedules, and tasks",
      "Design a customer feedback app with a clear review workflow",
    ],
    developerName: portable.author.name,
    displayName: "Autograph App Builder",
    logo: "./assets/autograph-icon.png",
    longDescription:
      "Use Autograph App Builder to design, plan, create, validate, and separately publish apps in explicitly supported repositories.",
    screenshots: [],
    shortDescription: "Design and create apps with Autograph",
    websiteURL: portable.homepage,
  },
  keywords: portable.keywords,
  license: portable.license,
  name: portable.name,
  repository: portable.repository,
  skills: "./skills/",
  version: portable.version,
};
type Manifest = typeof manifest & { apps?: string; mcpServers?: string };
const outputManifest: Manifest = manifest;
if (connectionId !== undefined && connectionId.length > 0) {
  outputManifest.apps = "./.app.json";
}
if (endpoint !== undefined && endpoint.length > 0) {
  outputManifest.mcpServers = "./.mcp.json";
}
const apps = { apps: new Map<string, { id: string }>() };
if (connectionId !== undefined && connectionId.length > 0) {
  apps.apps.set("app-builder", { id: connectionId });
}
await mkdir(path.resolve(".codex-plugin"), { recursive: true });
await writeFile(
  path.resolve(".codex-plugin/plugin.json"),
  await formatWithOxfmt(".codex-plugin/plugin.json", JSON.stringify(outputManifest)),
);
if (endpoint !== undefined && endpoint.length > 0) {
  portableServer.url = endpoint;
  const codexServer = {
    oauth_resource: endpoint,
    type: "http",
    url: endpoint,
  };
  type CodexServer = typeof codexServer & { oauth?: { callback_url: string; client_id: string } };
  const outputCodexServer: CodexServer = codexServer;
  if (suppliedEndpoint !== undefined && suppliedEndpoint.length > 0) {
    outputCodexServer.oauth = { callback_url: codexRedirectUri, client_id: codexClientId };
  }
  await writeFile(
    portableMcpPath,
    await formatWithOxfmt(portableMcpPath, JSON.stringify(portableMcp)),
  );
  await writeFile(
    path.resolve(".mcp.json"),
    await formatWithOxfmt(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          [AUTOGRAPH_MCP_SERVER_NAME]: outputCodexServer,
        },
      }),
    ),
  );
}
await writeFile(
  path.resolve(".app.json"),
  await formatWithOxfmt(".app.json", JSON.stringify(apps)),
);
let completionMessage =
  "Generated the skill-only OpenAI adapter; pass --connection-id after registering MCP.";
if (connectionId !== undefined && connectionId.length > 0) {
  completionMessage = "Generated the OpenAI adapter with its registered MCP connection.";
} else if (endpoint !== undefined && endpoint.length > 0) {
  completionMessage = `Generated the OpenAI adapter for ${endpoint}.`;
}
console.log(completionMessage);
