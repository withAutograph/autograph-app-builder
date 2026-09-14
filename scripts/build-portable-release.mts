import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";
import {
  deterministicGzip,
  deterministicTar,
  hasCanonicalFetchRemote,
  registeredAutographToolNames,
  releaseEndpoint,
  sha256,
} from "./portable-release";
import { readTrackedTreeBlob } from "./git-tree-blob";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index === -1) {return;}
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {throw new Error(`Missing value for ${name}.`);}
  return value;
};

const repositoryRoot = path.resolve(".");
const git = (...args: string[]) =>
  execFileSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    encoding: "utf-8",
    env: {
      HOME: process.env.HOME,
      LC_ALL: "C",
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
    },
  }).trim();
const sourceStatus = git("status", "--porcelain=v1");
if (sourceStatus !== "")
  {throw new Error(
    `Portable releases require a clean source checkout. Dirty entries:\n${sourceStatus}`,
  );}
const sourceRepository = "https://github.com/withAutograph/autograph-app-builder";
if (!hasCanonicalFetchRemote(git("remote", "-v"), sourceRepository))
  {throw new Error("Portable releases require the canonical source remote.");}
const source = {
  repository: sourceRepository,
  sha: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
};
const endpoint = releaseEndpoint(argument("--endpoint"));
const requestedOutput = path.resolve(
  argument("--output") ?? ".artifacts/portable-release/app-builder",
);
try {
  await lstat(requestedOutput);
  throw new Error(`Release output already exists: ${requestedOutput}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
}
const requestedParent = path.resolve(requestedOutput, "..");
await mkdir(requestedParent, { mode: 0o700, recursive: true });
const canonicalRequestedParent = await realpath(requestedParent);
const output = path.join(canonicalRequestedParent, path.basename(requestedOutput));
await mkdir(output, { mode: 0o700 });
const core = path.join(output, "app-builder");
await mkdir(core, { mode: 0o755 });
await Promise.all(
  ["plugin.json", "mcp.json", "LICENSE", "skills"].map(async (sourcePath) => {
    const sourceFile = path.resolve(repositoryRoot, sourcePath);
    const sourceFileStatus = await lstat(sourceFile);
    if (sourceFileStatus.isSymbolicLink())
      {throw new Error(`Portable source cannot be a symbolic link: ${sourcePath}`);}
    await cp(sourceFile, path.join(core, sourcePath), { recursive: true });
  }),
);
const mcp = JSON.parse(await readFile(path.join(core, "mcp.json"), "utf-8"));
mcp.mcpServers["app-builder"].url = `${endpoint}/mcp`;
await writeFile(path.join(core, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
await validateAgentPluginPackage({
  packageKind: "generated-artifact",
  pluginRoot: core,
  release: true,
  repositoryRoot,
});

const handlerSource = await readFile(path.resolve("lib/mcp/request-handler.ts"), "utf-8");
const tools = registeredAutographToolNames(handlerSource);
const mockRoot = path.join(output, "mock");
await mkdir(mockRoot);
await writeFile(
  path.join(mockRoot, "tools-list.json"),
  `${JSON.stringify(
    {
      id: 1,
      jsonrpc: "2.0",
      result: { tools: tools.map((name) => ({ name })) },
    },
    null,
    2,
  )}\n`,
);

const clientRoot = path.join(output, "clients");
await mkdir(clientRoot);
await Promise.all(
  (["vscode", "cursor", "codex"] as const).map((client) =>
    writeFile(
      path.join(clientRoot, `${client}.client-harness.json`),
      `${JSON.stringify(
        {
          client,
          format: "agent-plugins-client-harness-v2",
          mcp: "../app-builder/mcp.json",
          oauth: {
            protectedResourceMetadata: `${endpoint}/.well-known/oauth-protected-resource`,
          },
          pluginRoot: "../app-builder",
          transport: { type: "streamable-http", url: `${endpoint}/mcp` },
        },
        null,
        2,
      )}\n`,
    ),
  ),
);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function collectFiles(root: string, directory: string): Promise<Map<string, Uint8Array>> {
  const directoryEntries = await readdir(directory);
  const entries = await Promise.all(
    directoryEntries.toSorted().map(async (entry) => {
      const filePath = path.join(directory, entry);
      const fileStatus = await stat(filePath);
      if (fileStatus.isDirectory()) {return collectFiles(root, filePath);}
      return new Map([[path.relative(root, filePath), await readFile(filePath)]]);
    }),
  );
  return new Map(entries.flatMap((entry) => [...entry]));
}
const files = await collectFiles(output, core);
const archive = deterministicGzip(deterministicTar(files));
const portable = JSON.parse(await readFile(path.join(core, "plugin.json"), "utf-8"));
const archiveName = `${portable.name}-${portable.version}.tar.gz`;
await writeFile(path.join(output, archiveName), archive);

const marketplaceRoot = path.join(output, "codex-marketplace");
const marketplacePluginRoot = path.join(marketplaceRoot, "plugins", portable.name);
await mkdir(path.join(marketplacePluginRoot, ".codex-plugin"), {
  mode: 0o755,
  recursive: true,
});
await cp(core, marketplacePluginRoot, { recursive: true });
const codexManifest = JSON.parse(
  await readFile(path.resolve(".codex-plugin/plugin.json"), "utf-8"),
);
if (codexManifest.name !== portable.name || codexManifest.version !== portable.version)
  {throw new Error("The Codex adapter name and version must match the portable manifest.");}
const codexAssetReferences = [codexManifest.interface?.composerIcon, codexManifest.interface?.logo];
const codexMarketplaceAssetPaths = await Promise.all(
  [...new Set(codexAssetReferences)].map(async (reference) => {
    if (
      typeof reference !== "string" ||
      !reference.startsWith("./") ||
      reference.includes("\\") ||
      reference
        .slice(2)
        .split("/")
        .some((part: string) => part === "" || part === "." || part === "..")
    )
      {throw new Error("Codex manifest asset references must be safe relative paths.");}
    const relativeAssetPath = reference.slice(2);
    const sourceAsset = readTrackedTreeBlob({
      path: relativeAssetPath,
      repositoryRoot,
      tree: source.tree,
    });
    const destinationAsset = path.join(marketplacePluginRoot, relativeAssetPath);
    await mkdir(path.dirname(destinationAsset), { mode: 0o755, recursive: true });
    await writeFile(destinationAsset, sourceAsset.bytes, { mode: 0o644 });
    return `plugins/${portable.name}/${relativeAssetPath}`;
  }),
);
await writeFile(
  path.join(marketplacePluginRoot, ".codex-plugin", "plugin.json"),
  `${JSON.stringify(codexManifest, null, 2)}\n`,
);
await writeFile(
  path.join(marketplacePluginRoot, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        [portable.name]: {
          oauth_resource: `${endpoint}/mcp`,
          type: "http",
          url: `${endpoint}/mcp`,
        },
      },
    },
    null,
    2,
  )}\n`,
);
const marketplacePath = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
await mkdir(path.dirname(marketplacePath), { mode: 0o755, recursive: true });
await writeFile(
  marketplacePath,
  `${JSON.stringify(
    {
      interface: { displayName: "Autograph" },
      name: "autograph",
      plugins: [
        {
          category: "Developer Tools",
          name: portable.name,
          policy: {
            authentication: "ON_USE",
            installation: "AVAILABLE",
          },
          source: {
            path: `./plugins/${portable.name}`,
            source: "local",
          },
        },
      ],
    },
    null,
    2,
  )}\n`,
);
const marketplaceFiles = await collectFiles(marketplaceRoot, marketplaceRoot);
const marketplaceArchive = deterministicGzip(deterministicTar(marketplaceFiles));
const marketplaceArchiveName = `${portable.name}-codex-marketplace-${portable.version}.tar.gz`;
await writeFile(path.join(output, marketplaceArchiveName), marketplaceArchive);

const auxiliaryFiles = new Map<string, Uint8Array>();
for (const directory of [mockRoot, clientRoot]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  const directoryEntries = await readdir(directory);
  for (const entry of directoryEntries.toSorted()) {
    const filePath = path.join(directory, entry);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    auxiliaryFiles.set(path.relative(output, filePath), await readFile(filePath));
  }
}
const receipt = {
  archive: { name: archiveName, sha256: sha256(archive) },
  auxiliaryFiles: Object.fromEntries(
    [...auxiliaryFiles].toSorted().map(([filePath, content]) => [filePath, sha256(content)]),
  ),
  codexMarketplaceArchive: {
    name: marketplaceArchiveName,
    sha256: sha256(marketplaceArchive),
  },
  codexMarketplaceAssets: Object.fromEntries(
    codexMarketplaceAssetPaths.toSorted().map((filePath) => {
      const content = marketplaceFiles.get(filePath);
      if (!content) {throw new Error(`Codex marketplace omitted referenced asset ${filePath}.`);}
      return [filePath, sha256(content)];
    }),
  ),
  coreFiles: Object.fromEntries(
    [...files].toSorted().map(([filePath, content]) => [filePath, sha256(content)]),
  ),
  endpoint: `${endpoint}/mcp`,
  format: "autograph-portable-plugin-release-v3",
  name: portable.name,
  source,
  specification: "1.0.0",
  tools,
  version: portable.version,
};
await writeFile(path.join(output, "release-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
await writeFile(
  path.join(output, "SHA256SUMS"),
  `${receipt.archive.sha256}  ${receipt.archive.name}\n${receipt.codexMarketplaceArchive.sha256}  ${receipt.codexMarketplaceArchive.name}\n`,
);
const canonicalCore = await realpath(core);
if (canonicalCore !== core) {throw new Error("Portable core path was not canonical.");}
console.log(`Sealed ${archiveName}: ${receipt.archive.sha256}`);
