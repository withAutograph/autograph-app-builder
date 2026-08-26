import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
};
const client = argument("--client");
const sourceValue = argument("--source");
const destinationValue = argument("--destination");
if (
  !sourceValue ||
  !destinationValue ||
  !["vscode", "cursor", "codex"].includes(client ?? "")
)
  throw new Error(
    "Usage: --client vscode|cursor|codex --source RELEASE_ROOT --destination DIRECTORY",
  );
const source = await realpath(resolve(sourceValue));
if (!(await lstat(source)).isDirectory())
  throw new Error("Release root must be a real directory.");
const requestedDestination = resolve(destinationValue);
await mkdir(requestedDestination, { recursive: true, mode: 0o700 });
const destination = await realpath(requestedDestination);
await validateAgentPluginPackage({
  pluginRoot: join(source, "autograph-app-builder"),
  repositoryRoot: resolve("."),
  release: true,
  packageKind: "generated-artifact",
});
const clientRoot = join(destination, client as string);
try {
  await lstat(clientRoot);
  throw new Error(`Client install already exists: ${clientRoot}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await mkdir(clientRoot, { mode: 0o700 });
await cp(
  join(source, "autograph-app-builder"),
  join(clientRoot, "autograph-app-builder"),
  { recursive: true },
);
const harness = JSON.parse(
  await readFile(
    join(source, "clients", `${client}.offline-harness.json`),
    "utf8",
  ),
);
harness.pluginRoot = "./autograph-app-builder";
harness.mcp = "./autograph-app-builder/mcp.json";
await writeFile(
  join(clientRoot, "offline-harness.json"),
  `${JSON.stringify(harness, null, 2)}\n`,
);
const release = JSON.parse(
  await readFile(join(source, "release-receipt.json"), "utf8"),
);
await writeFile(
  join(clientRoot, "installation-receipt.json"),
  `${JSON.stringify(
    {
      format: "agent-plugins-offline-installation-v1",
      client,
      releaseArchive: release.archive,
      pluginRoot: "./autograph-app-builder",
    },
    null,
    2,
  )}\n`,
);
console.log(`Installed offline ${client} harness at ${clientRoot}`);
