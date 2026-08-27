import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";
import {
  deterministicGzip,
  deterministicTar,
  releaseEndpoint,
  sha256,
  TOOL_NAMES,
} from "./portable-release";

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceHash = z.string().regex(/^[0-9a-f]{40}$/u);
const digestRecord = z.record(z.string().min(1), hash);

export const portableReleaseReceiptSchema = z
  .object({
    format: z.literal("autograph-portable-plugin-release-v2"),
    specification: z.literal("1.0.0"),
    name: z.literal("autograph-app-builder"),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
    source: z
      .object({
        repository: z.literal(
          "https://github.com/withAutograph/autograph-app-builder",
        ),
        sha: sourceHash,
        tree: sourceHash,
      })
      .strict(),
    endpoint: z.string().url().startsWith("https://"),
    archive: z.object({ name: z.string().min(1), sha256: hash }).strict(),
    coreFiles: digestRecord,
    auxiliaryFiles: digestRecord,
    tools: z.tuple([
      z.literal("eve_start"),
      z.literal("eve_get"),
      z.literal("eve_send"),
      z.literal("eve_respond"),
      z.literal("eve_cancel"),
    ]),
  })
  .strict();

export type PortableReleaseReceipt = z.infer<
  typeof portableReleaseReceiptSchema
>;

function safeRelative(path: string) {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function archiveFiles(archive: Uint8Array) {
  const tar = gunzipSync(archive);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0))
        throw new Error("Archive contained bytes after its zero terminator.");
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/u, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const type = header[156];
    if (!safeRelative(name) || !Number.isSafeInteger(size) || size < 0)
      throw new Error("Archive entry name or size was invalid.");
    if (![0, "0".charCodeAt(0)].includes(type) || files.has(name))
      throw new Error("Archive must contain unique regular files only.");
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.byteLength)
      throw new Error("Archive entry exceeded the archive boundary.");
    files.set(name, tar.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (files.size === 0) throw new Error("Archive contained no files.");
  if (!Buffer.from(deterministicGzip(deterministicTar(files))).equals(archive))
    throw new Error("Archive headers or ordering were not deterministic.");
  return files;
}

async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected a regular non-symbolic file: ${basename(path)}`);
  return readFile(path);
}

function git(repositoryRoot: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      LC_ALL: "C",
      NODE_ENV: "production",
    },
  }).trim();
}

function exactKeys(actual: Record<string, string>, expected: string[]) {
  const keys = Object.keys(actual).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort()))
    throw new Error("Receipt file inventory was not exact.");
}

export async function verifyPortableProofArtifact(input: {
  releaseRoot: string;
  installRoot: string;
  repositoryRoot: string;
}) {
  const releaseRoot = await realpath(resolve(input.releaseRoot));
  const installRoot = await realpath(resolve(input.installRoot));
  const repositoryRoot = await realpath(resolve(input.repositoryRoot));
  const receiptPath = join(releaseRoot, "release-receipt.json");
  const receiptBytes = await regularFile(receiptPath);
  const receipt = portableReleaseReceiptSchema.parse(
    JSON.parse(receiptBytes.toString("utf8")),
  );
  const origin = releaseEndpoint(new URL(receipt.endpoint).origin);
  if (receipt.endpoint !== `${origin}/mcp`)
    throw new Error("Release endpoint must bind the exact /mcp resource.");
  if (
    receipt.source.sha !== git(repositoryRoot, "rev-parse", "HEAD") ||
    receipt.source.tree !== git(repositoryRoot, "rev-parse", "HEAD^{tree}")
  )
    throw new Error(
      "Release source SHA/tree did not match the proof checkout.",
    );
  if (
    !git(repositoryRoot, "remote", "-v")
      .split("\n")
      .some((line) => line.includes(`\t${receipt.source.repository} (fetch)`))
  )
    throw new Error(
      "Release source repository was not a configured fetch remote.",
    );
  const archiveName = `${receipt.name}-${receipt.version}.tar.gz`;
  if (
    receipt.archive.name !== archiveName ||
    basename(receipt.archive.name) !== receipt.archive.name
  )
    throw new Error("Release archive basename was invalid.");
  const archive = await regularFile(join(releaseRoot, receipt.archive.name));
  if (sha256(archive) !== receipt.archive.sha256)
    throw new Error("Release archive digest did not match its receipt.");
  const archived = archiveFiles(archive);
  exactKeys(receipt.coreFiles, [...archived.keys()]);
  for (const [path, bytes] of archived) {
    if (receipt.coreFiles[path] !== sha256(bytes))
      throw new Error(`Archive core digest drifted at ${path}.`);
    const loose = await regularFile(join(releaseRoot, path));
    if (sha256(loose) !== receipt.coreFiles[path])
      throw new Error(`Loose core file drifted at ${path}.`);
  }
  const auxiliaryPaths = [
    "clients/codex.client-harness.json",
    "clients/cursor.client-harness.json",
    "clients/vscode.client-harness.json",
    "mock/tools-list.json",
  ];
  exactKeys(receipt.auxiliaryFiles, auxiliaryPaths);
  for (const path of auxiliaryPaths) {
    const bytes = await regularFile(join(releaseRoot, path));
    if (receipt.auxiliaryFiles[path] !== sha256(bytes))
      throw new Error(`Auxiliary file drifted at ${path}.`);
  }
  const coreRoot = join(releaseRoot, receipt.name);
  await validateAgentPluginPackage({
    pluginRoot: coreRoot,
    repositoryRoot,
    release: true,
    packageKind: "generated-artifact",
  });
  for (const client of ["codex", "cursor", "vscode"] as const) {
    const clientRoot = join(installRoot, client);
    const installedRoot = join(clientRoot, receipt.name);
    await validateAgentPluginPackage({
      pluginRoot: installedRoot,
      repositoryRoot,
      release: true,
      packageKind: "generated-artifact",
    });
    for (const [path, expectedDigest] of Object.entries(receipt.coreFiles)) {
      const relativePath = relative(receipt.name, path);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..")
        throw new Error("Core receipt path escaped the plugin root.");
      if (
        sha256(await regularFile(join(installedRoot, relativePath))) !==
        expectedDigest
      )
        throw new Error(`${client} installed core drifted at ${relativePath}.`);
    }
    const harness = z
      .object({
        format: z.literal("agent-plugins-client-harness-v2"),
        client: z.literal(client),
        pluginRoot: z.literal("./autograph-app-builder"),
        mcp: z.literal("./autograph-app-builder/mcp.json"),
        transport: z
          .object({
            type: z.literal("streamable-http"),
            url: z.literal(receipt.endpoint),
          })
          .strict(),
        oauth: z
          .object({
            protectedResourceMetadata: z.literal(
              `${origin}/.well-known/oauth-protected-resource`,
            ),
          })
          .strict(),
      })
      .strict()
      .parse(
        JSON.parse(
          (await regularFile(join(clientRoot, "client-harness.json"))).toString(
            "utf8",
          ),
        ),
      );
    if (harness.client !== client) throw new Error("Client adapter drifted.");
    const installation = z
      .object({
        format: z.literal("agent-plugins-offline-installation-v1"),
        client: z.literal(client),
        releaseArchive: z
          .object({
            name: z.literal(receipt.archive.name),
            sha256: z.literal(receipt.archive.sha256),
          })
          .strict(),
        pluginRoot: z.literal("./autograph-app-builder"),
      })
      .strict()
      .parse(
        JSON.parse(
          (
            await regularFile(join(clientRoot, "installation-receipt.json"))
          ).toString("utf8"),
        ),
      );
    if (installation.client !== client)
      throw new Error("Installed client receipt drifted.");
  }
  if (JSON.stringify(receipt.tools) !== JSON.stringify(TOOL_NAMES))
    throw new Error("Release did not bind the exact five Eve tools.");
  return { receipt, receiptSha256: sha256(receiptBytes) };
}
