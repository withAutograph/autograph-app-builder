import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexClientId, codexRedirectUri } from "../lib/auth/codex-client-metadata.ts";
import { formatWithOxfmt } from "./format-with-oxfmt.mts";
import {
  assertAutographMcpEndpoint,
  AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT,
  AUTOGRAPH_MCP_SERVER_NAME,
  AUTOGRAPH_PACKAGE_VERSION,
} from "../lib/plugin/agent-plugin-package.ts";

interface CodexOAuthOptions {
  oauth?: { callback_url: string; client_id: string };
}

const portable = JSON.parse(await readFile(path.resolve("plugin.json"), "utf-8"));
const connectionIndex = process.argv.indexOf("--connection-id");
const connectionId = connectionIndex === -1 ? undefined : process.argv[connectionIndex + 1];
const endpointIndex = process.argv.indexOf("--endpoint");
const suppliedEndpoint = endpointIndex === -1 ? undefined : process.argv[endpointIndex + 1];
const hasConnectionId = connectionId !== null && connectionId !== undefined && connectionId !== "";
const hasSuppliedEndpoint =
  suppliedEndpoint !== null && suppliedEndpoint !== undefined && suppliedEndpoint !== "";
const endpoint =
  suppliedEndpoint ?? (hasConnectionId ? undefined : AUTOGRAPH_DEVELOPMENT_MCP_ENDPOINT);
const hasEndpoint = endpoint !== null && endpoint !== undefined && endpoint !== "";

if (connectionIndex === -1 || hasConnectionId) {
  // The option is absent or has a value.
} else {
  throw new Error("Missing value for --connection-id.");
}
if (endpointIndex === -1 || hasSuppliedEndpoint) {
  // The option is absent or has a value.
} else {
  throw new Error("Missing value for --endpoint.");
}

if (hasConnectionId && hasSuppliedEndpoint) {
  throw new Error("Pass either --connection-id or --endpoint, not both.");
}

// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
if (portable.version !== AUTOGRAPH_PACKAGE_VERSION) {
  throw new Error(`plugin.json version must be exactly ${AUTOGRAPH_PACKAGE_VERSION}.`);
}

if (hasSuppliedEndpoint) {
  assertAutographMcpEndpoint(suppliedEndpoint, { release: true });
}

const portableMcpPath = path.resolve("mcp.json");
const portableMcp = JSON.parse(await readFile(portableMcpPath, "utf-8"));
// oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Preserve the existing package manifest JSON boundary.
const portableServerNames = Object.keys(portableMcp.mcpServers ?? {});
if (portableServerNames.length !== 1 || portableServerNames[0] !== AUTOGRAPH_MCP_SERVER_NAME) {
  throw new Error(`mcp.json must declare exactly one ${AUTOGRAPH_MCP_SERVER_NAME} MCP server.`);
}
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
const portableServer = portableMcp.mcpServers[AUTOGRAPH_MCP_SERVER_NAME];
if (
  !portableServer ||
  typeof portableServer !== "object" ||
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  portableServer.type !== "streamable-http"
) {
  throw new Error(`${AUTOGRAPH_MCP_SERVER_NAME} must use the streamable-http transport.`);
}
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
assertAutographMcpEndpoint(portableServer.url, { release: false });

const manifestBase = {
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  author: portable.author,
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  description: portable.description,
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
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
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
    developerName: portable.author.name,
    displayName: "Autograph App Builder",
    logo: "./assets/autograph-icon.png",
    longDescription:
      "Use Autograph App Builder to design, plan, create, validate, and separately publish apps in explicitly supported repositories.",
    screenshots: [],
    shortDescription: "Design and create apps with Autograph",
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
    websiteURL: portable.homepage,
  },
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  keywords: portable.keywords,
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  license: portable.license,
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  name: portable.name,
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  repository: portable.repository,
  skills: "./skills/",
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  version: portable.version,
};
const manifest: typeof manifestBase & { apps?: string; mcpServers?: string } = manifestBase;
if (hasConnectionId) {
  manifest.apps = "./.app.json";
}
if (hasEndpoint) {
  manifest.mcpServers = "./.mcp.json";
}
const apps = hasConnectionId ? { apps: { "app-builder": { id: connectionId } } } : { apps: {} };
await mkdir(path.resolve(".codex-plugin"), { recursive: true });
await writeFile(
  path.resolve(".codex-plugin/plugin.json"),
  await formatWithOxfmt(".codex-plugin/plugin.json", JSON.stringify(manifest)),
);
if (hasEndpoint) {
  // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
  portableServer.url = endpoint;
  await writeFile(
    portableMcpPath,
    await formatWithOxfmt(portableMcpPath, JSON.stringify(portableMcp)),
  );
  const codexMcpPath = path.resolve(".mcp.json");
  const oauthOptions: CodexOAuthOptions = {};
  if (hasSuppliedEndpoint) {
    oauthOptions.oauth = { callback_url: codexRedirectUri, client_id: codexClientId };
  }
  await writeFile(
    codexMcpPath,
    await formatWithOxfmt(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          [AUTOGRAPH_MCP_SERVER_NAME]: {
            ...oauthOptions,
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
if (hasConnectionId) {
  completionMessage = "Generated the OpenAI adapter with its registered MCP connection.";
} else if (hasEndpoint) {
  completionMessage = `Generated the OpenAI adapter for ${endpoint}.`;
}
console.log(completionMessage);
