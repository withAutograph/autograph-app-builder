import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";

const portable = JSON.parse(await readFile(resolve("plugin.json"), "utf8"));
const connectionIndex = process.argv.indexOf("--connection-id");
const connectionId =
  connectionIndex >= 0 ? process.argv[connectionIndex + 1] : undefined;
const endpointIndex = process.argv.indexOf("--endpoint");
const suppliedEndpoint =
  endpointIndex >= 0 ? process.argv[endpointIndex + 1] : undefined;
const endpoint =
  suppliedEndpoint ?? (connectionId ? undefined : "http://127.0.0.1:3000/mcp");

if (connectionId && suppliedEndpoint) {
  throw new Error("Pass either --connection-id or --endpoint, not both.");
}

if (endpoint) {
  const url = new URL(endpoint);
  const isLoopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !isLoopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "--endpoint must be credential-free HTTPS or an HTTP loopback URL.",
    );
  }
}

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
    shortDescription: "Design and create supported Autograph apps",
    longDescription:
      "Use a durable Eve agent to design, plan, create, validate, and separately publish apps in supported repositories.",
    developerName: portable.author.name,
    category: "Developer Tools",
    capabilities: ["Interactive", "Read", "Write"],
    websiteURL: portable.homepage,
    defaultPrompt: [
      "Design a new app only through Eve. If eve_start is unavailable, stop without implementing directly.",
      "Create a supported app only through Eve. If eve_start is unavailable, stop without another app builder.",
      "Continue my Eve session. If the Eve tools are unavailable, stop and report the missing connection.",
    ],
    brandColor: "#111827",
    screenshots: [],
  },
};
const apps = connectionId
  ? { apps: { "eve-agent": { id: connectionId } } }
  : { apps: {} };
await mkdir(resolve(".codex-plugin"), { recursive: true });
await writeFile(
  resolve(".codex-plugin/plugin.json"),
  await format(JSON.stringify(manifest), { parser: "json" }),
);
if (endpoint) {
  await writeFile(
    resolve(".mcp.json"),
    await format(
      JSON.stringify({
        mcpServers: {
          "autograph-app-builder": { type: "http", url: endpoint },
        },
      }),
      { parser: "json" },
    ),
  );
}
await writeFile(
  resolve(".app.json"),
  await format(JSON.stringify(apps), { parser: "json" }),
);
console.log(
  connectionId
    ? "Generated the OpenAI adapter with its registered MCP connection."
    : endpoint
      ? `Generated the OpenAI adapter for ${endpoint}.`
      : "Generated the skill-only OpenAI adapter; pass --connection-id after registering MCP.",
);
