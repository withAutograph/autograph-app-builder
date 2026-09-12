import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatWithOxfmt } from "./format-with-oxfmt.mts";
import {
  assertAutographMcpEndpoint,
  AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT,
  AUTOGRAPH_MCP_SERVER_NAME,
  AUTOGRAPH_PACKAGE_VERSION,
} from "../lib/plugin/agent-plugin-package.ts";

const portable = JSON.parse(await readFile(resolve("plugin.json"), "utf8"));
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

const portableMcpPath = resolve("mcp.json");
const portableMcp = JSON.parse(await readFile(portableMcpPath, "utf8"));
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
  name: portable.name,
  version: portable.version,
  description: portable.description,
  author: portable.author,
  homepage: portable.homepage,
  repository: portable.repository,
  license: portable.license,
  keywords: portable.keywords,
  skills: "./skills/",
  ...(connectionId ? { apps: "./.app.json" } : {}),
  ...(endpoint ? { mcpServers: "./.mcp.json" } : {}),
  interface: {
    displayName: "Autograph App Builder",
    shortDescription: "Design and create apps with Autograph",
    longDescription:
      "Use Autograph App Builder to design, plan, create, validate, and separately publish apps in explicitly supported repositories.",
    developerName: portable.author.name,
    category: "Developer Tools",
    capabilities: ["Interactive", "Read", "Write"],
    composerIcon: "./assets/autograph-icon.png",
    logo: "./assets/autograph-icon.png",
    websiteURL: portable.homepage,
    defaultPrompt: [
      "Create an app for [who it is for, what they need to do, and the outcome you want]",
      "Build an event planning app for coordinating guests, schedules, and tasks",
      "Design a customer feedback app with a clear review workflow",
    ],
    brandColor: "#111827",
    screenshots: [],
  },
};
const apps = connectionId ? { apps: { "app-builder": { id: connectionId } } } : { apps: {} };
await mkdir(resolve(".codex-plugin"), { recursive: true });
await writeFile(
  resolve(".codex-plugin/plugin.json"),
  await formatWithOxfmt(".codex-plugin/plugin.json", JSON.stringify(manifest)),
);
if (endpoint) {
  portableServer.url = endpoint;
  await writeFile(
    portableMcpPath,
    await formatWithOxfmt(portableMcpPath, JSON.stringify(portableMcp)),
  );
  await writeFile(
    resolve(".mcp.json"),
    await formatWithOxfmt(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          [AUTOGRAPH_MCP_SERVER_NAME]: {
            type: "http",
            url: endpoint,
            oauth_resource: endpoint,
          },
        },
      }),
    ),
  );
}
await writeFile(resolve(".app.json"), await formatWithOxfmt(".app.json", JSON.stringify(apps)));
console.log(
  connectionId
    ? "Generated the OpenAI adapter with its registered MCP connection."
    : endpoint
      ? `Generated the OpenAI adapter for ${endpoint}.`
      : "Generated the skill-only OpenAI adapter; pass --connection-id after registering MCP.",
);
