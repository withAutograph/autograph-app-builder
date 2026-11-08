/* oxlint-disable typescript/no-unsafe-member-access -- Preserve the existing untyped input and rendering boundary. */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";
import { sha256, TOOL_NAMES } from "./portable-release";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  // oxlint-disable-next-line typescript/consistent-return -- Preserve optional command-line argument results.
  return value;
};
const releaseValue = argument("--release");
const installValue = argument("--install-root");
/* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
if (!releaseValue || !installValue) {
  throw new Error("Usage: --release RELEASE_ROOT --install-root DIRECTORY");
}
/* oxlint-enable typescript/strict-boolean-expressions */
const releaseRoot = path.resolve(releaseValue);
const installRoot = path.resolve(installValue);
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing JSON parsing boundary.
const receipt = JSON.parse(await readFile(path.join(releaseRoot, "release-receipt.json"), "utf-8"));
if (
  receipt.format !== "autograph-portable-plugin-release-v3" ||
  receipt.specification !== "1.0.0" ||
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing portable release receipt boundary.
  !/^[0-9a-f]{40}$/u.test(receipt.source?.sha ?? "") ||
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing portable release receipt boundary.
  !/^[0-9a-f]{40}$/u.test(receipt.source?.tree ?? "")
) {
  throw new Error("Portable release receipt was invalid.");
}
if (!Array.isArray(receipt.tools) || JSON.stringify(receipt.tools) !== JSON.stringify(TOOL_NAMES)) {
  throw new Error("Portable release receipt was invalid.");
}
// oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing portable release receipt boundary.
const archive = await readFile(path.join(releaseRoot, receipt.archive.name));
if (sha256(archive) !== receipt.archive.sha256) {
  throw new Error("Portable archive digest did not match its receipt.");
}
const marketplaceArchive = await readFile(
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing portable release receipt boundary.
  path.join(releaseRoot, receipt.codexMarketplaceArchive.name),
);
if (sha256(marketplaceArchive) !== receipt.codexMarketplaceArchive.sha256) {
  throw new Error("Codex marketplace digest did not match its receipt.");
}
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing JSON parsing boundary.
const discovery = JSON.parse(
  await readFile(path.join(releaseRoot, "mock/tools-list.json"), "utf-8"),
);
// oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-assignment -- Discovery is read from the generated MCP response without changing its error behavior.; Preserve the existing dynamic value boundary.
const discovered = discovery.result?.tools?.map((tool: { name?: unknown }) => tool.name);
if (JSON.stringify(discovered) !== JSON.stringify(TOOL_NAMES)) {
  throw new Error("Offline MCP discovery did not return the exact five tools.");
}

await Promise.all(
  (["vscode", "cursor", "codex"] as const).map(async (client) => {
    const root = path.join(installRoot, client);
    const pluginRoot = path.join(root, "app-builder");
    await Promise.all([
      validateAgentPluginPackage({
        packageKind: "generated-artifact",
        pluginRoot,
        release: true,
        repositoryRoot: path.resolve("."),
      }),
      ...Object.entries(receipt.coreFiles as Record<string, string>).map(
        async ([filePath, digest]) => {
          const relativePath = filePath.replace(/^app-builder\//u, "");
          const bytes = await readFile(path.join(pluginRoot, relativePath));
          if (sha256(bytes) !== digest) {
            throw new Error(`${client} installed bytes drifted at ${relativePath}.`);
          }
        },
      ),
      ...[".codex-plugin", ".app.json"].map(async (forbidden) => {
        try {
          await lstat(path.join(pluginRoot, forbidden));
          throw new Error(`${client} portable root contains ${forbidden}.`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }),
    ]);
    const [harnessBytes, installationBytes] = await Promise.all([
      readFile(path.join(root, "client-harness.json"), "utf-8"),
      readFile(path.join(root, "installation-receipt.json"), "utf-8"),
    ]);
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing JSON parsing boundary.
    const harness = JSON.parse(harnessBytes);
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing JSON parsing boundary.
    const installation = JSON.parse(installationBytes);
    if (
      harness.format !== "agent-plugins-client-harness-v2" ||
      harness.client !== client ||
      harness.pluginRoot !== "./app-builder" ||
      harness.mcp !== "./app-builder/mcp.json"
    ) {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    if (
      harness.transport?.type !== "streamable-http" ||
      harness.transport?.url !== receipt.endpoint ||
      harness.oauth?.protectedResourceMetadata !==
        // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing portable release receipt boundary.
        `${new URL(receipt.endpoint).origin}/.well-known/oauth-protected-resource`
    ) {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    if (
      installation.client !== client ||
      installation.releaseArchive.sha256 !== receipt.archive.sha256
    ) {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
  }),
);
console.log(
  "Portable VS Code, Cursor, and Codex package loading plus exact-five-tool discovery passed.",
);
