import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { portableReleaseReceiptSchema } from "./portable-proof-artifact";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";
import { sha256, TOOL_NAMES } from "./portable-release";

const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    throw new Error(`Missing value for ${name}.`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
};
const releaseValue = argument("--release");
const installValue = argument("--install-root");
const releaseRoot = path.resolve(releaseValue);
const installRoot = path.resolve(installValue);
const missingFileErrorSchema = z.object({ code: z.literal("ENOENT") });
const receiptValue: unknown = JSON.parse(
  await readFile(path.join(releaseRoot, "release-receipt.json"), "utf-8"),
);
const receipt = portableReleaseReceiptSchema.parse(receiptValue);
const archive = await readFile(path.join(releaseRoot, receipt.archive.name));
if (sha256(archive) !== receipt.archive.sha256) {
  throw new Error("Portable archive digest did not match its receipt.");
}
const marketplaceArchive = await readFile(
  path.join(releaseRoot, receipt.codexMarketplaceArchive.name),
);
if (sha256(marketplaceArchive) !== receipt.codexMarketplaceArchive.sha256) {
  throw new Error("Codex marketplace digest did not match its receipt.");
}
const discoveryValue: unknown = JSON.parse(
  await readFile(path.join(releaseRoot, "mock/tools-list.json"), "utf-8"),
);
const discoverySchema = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});
const discoveryResult = discoverySchema.safeParse(discoveryValue);
if (!discoveryResult.success) {
  throw new Error("Offline MCP discovery did not return the exact five tools.");
}
const discovered = discoveryResult.data.result.tools.map(({ name }) => name);
if (
  discovered.length !== TOOL_NAMES.length ||
  discovered.some((name, index) => name !== TOOL_NAMES[index])
) {
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
      ...Object.entries(receipt.coreFiles).map(async ([filePath, digest]) => {
        const relativePath = filePath.replace(/^app-builder\//u, "");
        const bytes = await readFile(path.join(pluginRoot, relativePath));
        if (sha256(bytes) !== digest) {
          throw new Error(`${client} installed bytes drifted at ${relativePath}.`);
        }
      }),
      ...[".codex-plugin", ".app.json"].map(async (forbidden) => {
        try {
          await lstat(path.join(pluginRoot, forbidden));
          throw new Error(`${client} portable root contains ${forbidden}.`);
        } catch (error) {
          if (!missingFileErrorSchema.safeParse(error).success) {
            throw error;
          }
        }
      }),
    ]);
    const [harnessBytes, installationBytes] = await Promise.all([
      readFile(path.join(root, "client-harness.json"), "utf-8"),
      readFile(path.join(root, "installation-receipt.json"), "utf-8"),
    ]);
    const harnessValue: unknown = JSON.parse(harnessBytes);
    const installationValue: unknown = JSON.parse(installationBytes);
    const harnessSchema = z.object({
      client: z.string(),
      format: z.string(),
      mcp: z.string(),
      oauth: z.object({ protectedResourceMetadata: z.string() }),
      pluginRoot: z.string(),
      transport: z.object({ type: z.string(), url: z.string() }),
    });
    const installationSchema = z.object({
      client: z.string(),
      releaseArchive: z.object({ sha256: z.string() }),
    });
    const harnessResult = harnessSchema.safeParse(harnessValue);
    const installationResult = installationSchema.safeParse(installationValue);
    if (!harnessResult.success) {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    if (!installationResult.success) {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    const harness = harnessResult.data;
    const installation = installationResult.data;
    if (harness.format !== "agent-plugins-client-harness-v2") {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    if (harness.client !== client || harness.pluginRoot !== "./app-builder") {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    if (harness.mcp !== "./app-builder/mcp.json" || harness.transport.type !== "streamable-http") {
      throw new Error(`${client} offline harness metadata was invalid.`);
    }
    if (
      harness.transport.url !== receipt.endpoint ||
      harness.oauth.protectedResourceMetadata !==
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
