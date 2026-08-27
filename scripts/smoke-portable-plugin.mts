import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";
import { sha256, TOOL_NAMES } from "./portable-release";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
};
const releaseValue = argument("--release");
const installValue = argument("--install-root");
if (!releaseValue || !installValue)
  throw new Error("Usage: --release RELEASE_ROOT --install-root DIRECTORY");
const releaseRoot = resolve(releaseValue);
const installRoot = resolve(installValue);
const receipt = JSON.parse(
  await readFile(join(releaseRoot, "release-receipt.json"), "utf8"),
);
if (
  receipt.format !== "autograph-portable-plugin-release-v3" ||
  receipt.specification !== "1.0.0" ||
  !/^[0-9a-f]{40}$/u.test(receipt.source?.sha ?? "") ||
  !/^[0-9a-f]{40}$/u.test(receipt.source?.tree ?? "") ||
  !Array.isArray(receipt.tools) ||
  JSON.stringify(receipt.tools) !== JSON.stringify(TOOL_NAMES)
)
  throw new Error("Portable release receipt was invalid.");
const archive = await readFile(join(releaseRoot, receipt.archive.name));
if (sha256(archive) !== receipt.archive.sha256)
  throw new Error("Portable archive digest did not match its receipt.");
const marketplaceArchive = await readFile(
  join(releaseRoot, receipt.codexMarketplaceArchive.name),
);
if (sha256(marketplaceArchive) !== receipt.codexMarketplaceArchive.sha256)
  throw new Error("Codex marketplace digest did not match its receipt.");
const discovery = JSON.parse(
  await readFile(join(releaseRoot, "mock/tools-list.json"), "utf8"),
);
const discovered = discovery.result?.tools?.map(
  (tool: { name?: unknown }) => tool.name,
);
if (JSON.stringify(discovered) !== JSON.stringify(TOOL_NAMES))
  throw new Error("Offline MCP discovery did not return the exact five tools.");

for (const client of ["vscode", "cursor", "codex"] as const) {
  const root = join(installRoot, client);
  const pluginRoot = join(root, "autograph-app-builder");
  await validateAgentPluginPackage({
    pluginRoot,
    repositoryRoot: resolve("."),
    release: true,
    packageKind: "generated-artifact",
  });
  for (const [path, digest] of Object.entries(
    receipt.coreFiles as Record<string, string>,
  )) {
    const relativePath = path.replace(/^autograph-app-builder\//u, "");
    const bytes = await readFile(join(pluginRoot, relativePath));
    if (sha256(bytes) !== digest)
      throw new Error(`${client} installed bytes drifted at ${relativePath}.`);
  }
  for (const forbidden of [".codex-plugin", ".app.json"]) {
    try {
      await lstat(join(pluginRoot, forbidden));
      throw new Error(`${client} portable root contains ${forbidden}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const harness = JSON.parse(
    await readFile(join(root, "client-harness.json"), "utf8"),
  );
  const installation = JSON.parse(
    await readFile(join(root, "installation-receipt.json"), "utf8"),
  );
  if (
    harness.format !== "agent-plugins-client-harness-v2" ||
    harness.client !== client ||
    harness.pluginRoot !== "./autograph-app-builder" ||
    harness.mcp !== "./autograph-app-builder/mcp.json" ||
    harness.transport?.type !== "streamable-http" ||
    harness.transport?.url !== receipt.endpoint ||
    harness.oauth?.protectedResourceMetadata !==
      `${new URL(receipt.endpoint).origin}/.well-known/oauth-protected-resource` ||
    installation.client !== client ||
    installation.releaseArchive.sha256 !== receipt.archive.sha256
  )
    throw new Error(`${client} offline harness metadata was invalid.`);
}
console.log(
  "Portable VS Code, Cursor, and Codex package loading plus exact-five-tool discovery passed.",
);
