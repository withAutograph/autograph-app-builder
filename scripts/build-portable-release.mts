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
import { basename, join, relative, resolve } from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";
import {
  deterministicGzip,
  deterministicTar,
  registeredEveToolNames,
  releaseEndpoint,
  sha256,
} from "./portable-release";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
};

const repositoryRoot = resolve(".");
const endpoint = releaseEndpoint(argument("--endpoint"));
const requestedOutput = resolve(
  argument("--output") ?? ".artifacts/portable-release/autograph-app-builder",
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
const core = join(output, "autograph-app-builder");
await mkdir(core, { mode: 0o755 });
for (const path of ["plugin.json", "mcp.json", "LICENSE", "skills"]) {
  const source = resolve(repositoryRoot, path);
  if ((await lstat(source)).isSymbolicLink())
    throw new Error(`Portable source cannot be a symbolic link: ${path}`);
  await cp(source, join(core, path), { recursive: true });
}
const mcp = JSON.parse(await readFile(join(core, "mcp.json"), "utf8"));
mcp.mcpServers["autograph-app-builder"].url = `${endpoint}/mcp`;
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
const tools = registeredEveToolNames(handlerSource);
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
    join(clientRoot, `${client}.offline-harness.json`),
    `${JSON.stringify(
      {
        format: "agent-plugins-offline-client-harness-v1",
        client,
        pluginRoot: "../autograph-app-builder",
        mcp: "../autograph-app-builder/mcp.json",
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

const auxiliaryFiles = new Map<string, Uint8Array>();
for (const directory of [mockRoot, clientRoot]) {
  for (const entry of (await readdir(directory)).sort()) {
    const path = join(directory, entry);
    auxiliaryFiles.set(relative(output, path), await readFile(path));
  }
}
const receipt = {
  format: "autograph-portable-plugin-release-v2",
  specification: "1.0.0",
  name: portable.name,
  version: portable.version,
  endpoint: `${endpoint}/mcp`,
  archive: { name: archiveName, sha256: sha256(archive) },
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
if ((await realpath(core)) !== core)
  throw new Error("Portable core path was not canonical.");
console.log(`Sealed ${archiveName}: ${receipt.archive.sha256}`);
