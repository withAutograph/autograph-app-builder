import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
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
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
};

const repositoryRoot = resolve(".");
const git = (...args: string[]) =>
  execFileSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      LC_ALL: "C",
      NODE_ENV: "production",
    },
  }).trim();
const sourceStatus = git("status", "--porcelain=v1");
if (sourceStatus !== "")
  throw new Error(
    `Portable releases require a clean source checkout. Dirty entries:\n${sourceStatus}`,
  );
const sourceRepository =
  "https://github.com/withAutograph/autograph-app-builder";
if (!hasCanonicalFetchRemote(git("remote", "-v"), sourceRepository))
  throw new Error("Portable releases require the canonical source remote.");
const source = {
  repository: sourceRepository,
  sha: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
};
const endpoint = releaseEndpoint(argument("--endpoint"));
const requestedOutput = resolve(
  argument("--output") ?? ".artifacts/portable-release/app-builder",
);
try {
  await lstat(requestedOutput);
  throw new Error(`Release output already exists: ${requestedOutput}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const requestedParent = resolve(requestedOutput, "..");
await mkdir(requestedParent, { recursive: true, mode: 0o700 });
const output = join(await realpath(requestedParent), basename(requestedOutput));
await mkdir(output, { mode: 0o700 });
const core = join(output, "app-builder");
await mkdir(core, { mode: 0o755 });
for (const path of ["plugin.json", "mcp.json", "LICENSE", "skills"]) {
  const source = resolve(repositoryRoot, path);
  if ((await lstat(source)).isSymbolicLink())
    throw new Error(`Portable source cannot be a symbolic link: ${path}`);
  await cp(source, join(core, path), { recursive: true });
}
const mcp = JSON.parse(await readFile(join(core, "mcp.json"), "utf8"));
mcp.mcpServers["app-builder"].url = `${endpoint}/mcp`;
await writeFile(join(core, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
await validateAgentPluginPackage({
  pluginRoot: core,
  repositoryRoot,
  release: true,
  packageKind: "generated-artifact",
});

const handlerSource = await readFile(
  resolve("lib/mcp/request-handler.ts"),
  "utf8",
);
const tools = registeredAutographToolNames(handlerSource);
const mockRoot = join(output, "mock");
await mkdir(mockRoot);
await writeFile(
  join(mockRoot, "tools-list.json"),
  `${JSON.stringify(
    {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: tools.map((name) => ({ name })) },
    },
    null,
    2,
  )}\n`,
);

const clientRoot = join(output, "clients");
await mkdir(clientRoot);
for (const client of ["vscode", "cursor", "codex"] as const) {
  await writeFile(
    join(clientRoot, `${client}.client-harness.json`),
    `${JSON.stringify(
      {
        format: "agent-plugins-client-harness-v2",
        client,
        pluginRoot: "../app-builder",
        mcp: "../app-builder/mcp.json",
        transport: { type: "streamable-http", url: `${endpoint}/mcp` },
        oauth: {
          protectedResourceMetadata: `${endpoint}/.well-known/oauth-protected-resource`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

const files = new Map<string, Uint8Array>();
async function collect(directory: string) {
  for (const entry of (await readdir(directory)).sort()) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) await collect(path);
    else files.set(relative(output, path), await readFile(path));
  }
}
await collect(core);
const archive = deterministicGzip(deterministicTar(files));
const portable = JSON.parse(await readFile(join(core, "plugin.json"), "utf8"));
const archiveName = `${portable.name}-${portable.version}.tar.gz`;
await writeFile(join(output, archiveName), archive);

const marketplaceRoot = join(output, "codex-marketplace");
const marketplacePluginRoot = join(marketplaceRoot, "plugins", portable.name);
await mkdir(join(marketplacePluginRoot, ".codex-plugin"), {
  recursive: true,
  mode: 0o755,
});
await cp(core, marketplacePluginRoot, { recursive: true });
const codexManifest = JSON.parse(
  await readFile(resolve(".codex-plugin/plugin.json"), "utf8"),
);
if (
  codexManifest.name !== portable.name ||
  codexManifest.version !== portable.version
)
  throw new Error(
    "The Codex adapter name and version must match the portable manifest.",
  );
const codexAssetReferences = [
  codexManifest.interface?.composerIcon,
  codexManifest.interface?.logo,
];
const codexMarketplaceAssetPaths: string[] = [];
for (const reference of new Set(codexAssetReferences)) {
  if (
    typeof reference !== "string" ||
    !reference.startsWith("./") ||
    reference.includes("\\") ||
    reference
      .slice(2)
      .split("/")
      .some((part: string) => part === "" || part === "." || part === "..")
  )
    throw new Error(
      "Codex manifest asset references must be safe relative paths.",
    );
  const relativeAssetPath = reference.slice(2);
  const sourceAsset = readTrackedTreeBlob({
    repositoryRoot,
    tree: source.tree,
    path: relativeAssetPath,
  });
  const destinationAsset = join(marketplacePluginRoot, relativeAssetPath);
  await mkdir(dirname(destinationAsset), { recursive: true, mode: 0o755 });
  await writeFile(destinationAsset, sourceAsset.bytes, { mode: 0o644 });
  codexMarketplaceAssetPaths.push(
    `plugins/${portable.name}/${relativeAssetPath}`,
  );
}
await writeFile(
  join(marketplacePluginRoot, ".codex-plugin", "plugin.json"),
  `${JSON.stringify(codexManifest, null, 2)}\n`,
);
await writeFile(
  join(marketplacePluginRoot, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        [portable.name]: { type: "http", url: `${endpoint}/mcp` },
      },
    },
    null,
    2,
  )}\n`,
);
const marketplacePath = join(
  marketplaceRoot,
  ".agents",
  "plugins",
  "marketplace.json",
);
await mkdir(dirname(marketplacePath), { recursive: true, mode: 0o755 });
await writeFile(
  marketplacePath,
  `${JSON.stringify(
    {
      name: "autograph",
      interface: { displayName: "Autograph" },
      plugins: [
        {
          name: portable.name,
          source: {
            source: "local",
            path: `./plugins/${portable.name}`,
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    },
    null,
    2,
  )}\n`,
);
const marketplaceFiles = new Map<string, Uint8Array>();
async function collectMarketplace(directory: string) {
  for (const entry of (await readdir(directory)).sort()) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) await collectMarketplace(path);
    else
      marketplaceFiles.set(
        relative(marketplaceRoot, path),
        await readFile(path),
      );
  }
}
await collectMarketplace(marketplaceRoot);
const marketplaceArchive = deterministicGzip(
  deterministicTar(marketplaceFiles),
);
const marketplaceArchiveName = `${portable.name}-codex-marketplace-${portable.version}.tar.gz`;
await writeFile(join(output, marketplaceArchiveName), marketplaceArchive);

const auxiliaryFiles = new Map<string, Uint8Array>();
for (const directory of [mockRoot, clientRoot]) {
  for (const entry of (await readdir(directory)).sort()) {
    const path = join(directory, entry);
    auxiliaryFiles.set(relative(output, path), await readFile(path));
  }
}
const receipt = {
  format: "autograph-portable-plugin-release-v3",
  specification: "1.0.0",
  name: portable.name,
  version: portable.version,
  source,
  endpoint: `${endpoint}/mcp`,
  archive: { name: archiveName, sha256: sha256(archive) },
  codexMarketplaceArchive: {
    name: marketplaceArchiveName,
    sha256: sha256(marketplaceArchive),
  },
  codexMarketplaceAssets: Object.fromEntries(
    codexMarketplaceAssetPaths.toSorted().map((path) => {
      const content = marketplaceFiles.get(path);
      if (!content)
        throw new Error(`Codex marketplace omitted referenced asset ${path}.`);
      return [path, sha256(content)];
    }),
  ),
  coreFiles: Object.fromEntries(
    [...files].sort().map(([path, content]) => [path, sha256(content)]),
  ),
  auxiliaryFiles: Object.fromEntries(
    [...auxiliaryFiles]
      .sort()
      .map(([path, content]) => [path, sha256(content)]),
  ),
  tools,
};
await writeFile(
  join(output, "release-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
await writeFile(
  join(output, "SHA256SUMS"),
  `${receipt.archive.sha256}  ${receipt.archive.name}\n${receipt.codexMarketplaceArchive.sha256}  ${receipt.codexMarketplaceArchive.name}\n`,
);
if ((await realpath(core)) !== core)
  throw new Error("Portable core path was not canonical.");
console.log(`Sealed ${archiveName}: ${receipt.archive.sha256}`);
