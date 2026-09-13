import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatWithOxfmt } from "./format-with-oxfmt.mts";
import {
  assertAutographMcpEndpoint,
  AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT,
  AUTOGRAPH_MCP_SERVER_NAME,
  AUTOGRAPH_PACKAGE_VERSION,
} from "../lib/plugin/agent-plugin-package.ts";

const portable = JSON.parse(await readFile(path.resolve("plugin.json"), "utf-8"));
const connectionIndex = process.argv.indexOf("--connection-id");
const connectionId = connectionIndex === -1 ? undefined : process.argv[connectionIndex + 1];
const endpointIndex = process.argv.indexOf("--endpoint");
const suppliedEndpoint = endpointIndex === -1 ? undefined : process.argv[endpointIndex + 1];
const endpoint =
  suppliedEndpoint ?? (connectionId ? undefined : AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT);

if (connectionIndex === -1 || connectionId) {
  // The option is absent or has a value.
} else throw new Error("Missing value for --connection-id.");
if (endpointIndex === -1 || suppliedEndpoint) {
  // The option is absent or has a value.
} else throw new Error("Missing value for --endpoint.");

if (connectionId && suppliedEndpoint) {
  throw new Error("Pass either --connection-id or --endpoint, not both.");
}

if (portable.version !== AUTOGRAPH_PACKAGE_VERSION)
  throw new Error(`plugin.json version must be exactly ${AUTOGRAPH_PACKAGE_VERSION}.`);

if (suppliedEndpoint) assertAutographMcpEndpoint(suppliedEndpoint, { release: true });

const portableMcpPath = path.resolve("mcp.json");
const portableMcp = JSON.parse(await readFile(portableMcpPath, "utf-8"));
const portableServerNames = Object.keys(portableMcp.mcpServers ?? {});
if (portableServerNames.length !== 1 || portableServerNames[0] !== AUTOGRAPH_MCP_SERVER_NAME)
  throw new Error(`mcp.json must declare exactly one ${AUTOGRAPH_MCP_SERVER_NAME} MCP server.`);
const portableServer = portableMcp.mcpServers[AUTOGRAPH_MCP_SERVER_NAME];
if (
  !portableServer ||
  typeof portableServer !== "object" ||
  portableServer.type !== "streamable-http"
)
  throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`);
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
  ...(connectionId ? { apps: "./.app.json" } : {}),
  ...(endpoint ? { mcpServers: "./.mcp.json" } : {}),
};
const apps = connectionId ? { apps: { "app-builder": { id: connectionId } } } : { apps: {} };
await mkdir(path.resolve(".codex-plugin"), { recursive: true });
await writeFile(
  path.resolve(".codex-plugin/plugin.json"),
  await formatWithOxfmt(".codex-plugin/plugin.json", JSON.stringify(manifest)),
);
if (endpoint) {
  portableServer.url = endpoint;
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
          [AUTOGRAPH_MCP_SERVER_NAME]: {
            oauth_resource: endpoint,
            type: "http",
            url: endpoint,
          },
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
if (connectionId)
  completionMessage = "Generated the OpenAI adapter with its registered MCP connection.";
else if (endpoint) completionMessage = `Generated the OpenAI adapter for ${endpoint}.`;
console.log(completionMessage);
