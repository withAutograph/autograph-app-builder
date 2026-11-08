/* oxlint-disable typescript/no-unsafe-member-access -- Preserve the existing untyped input and rendering boundary. */
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";

const pluginDirectoryName = "app-builder";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
};
const client = argument("--client");
const sourceValue = argument("--source");
const destinationValue = argument("--destination");
if (sourceValue === undefined || sourceValue === "") {
  throw new Error(
    "Usage: --client vscode|cursor|codex --source RELEASE_ROOT --destination DIRECTORY",
  );
}
if (
  destinationValue === undefined ||
  destinationValue === "" ||
  client === undefined ||
  !["vscode", "cursor", "codex"].includes(client)
) {
  throw new Error(
    "Usage: --client vscode|cursor|codex --source RELEASE_ROOT --destination DIRECTORY",
  );
}
const source = await realpath(path.resolve(sourceValue));
const sourceStats = await lstat(source);
if (!sourceStats.isDirectory()) {
  throw new Error("Release root must be a real directory.");
}
const requestedDestination = path.resolve(destinationValue);
await mkdir(requestedDestination, { mode: 0o700, recursive: true });
const destination = await realpath(requestedDestination);
await validateAgentPluginPackage({
  packageKind: "generated-artifact",
  pluginRoot: path.join(source, pluginDirectoryName),
  release: true,
  repositoryRoot: path.resolve("."),
});
const clientRoot = path.join(destination, client);
try {
  await lstat(clientRoot);
  throw new Error(`Client install already exists: ${clientRoot}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}
await mkdir(clientRoot, { mode: 0o700 });
await cp(path.join(source, pluginDirectoryName), path.join(clientRoot, pluginDirectoryName), {
  recursive: true,
});
const harness = JSON.parse(
  await readFile(path.join(source, "clients", `${client}.client-harness.json`), "utf-8"),
);
harness.pluginRoot = "./app-builder";
harness.mcp = "./app-builder/mcp.json";
await writeFile(
  path.join(clientRoot, "client-harness.json"),
  `${JSON.stringify(harness, null, 2)}\n`,
);
const release = JSON.parse(await readFile(path.join(source, "release-receipt.json"), "utf-8"));
await writeFile(
  path.join(clientRoot, "installation-receipt.json"),
  `${JSON.stringify(
    {
      client,
      format: "agent-plugins-offline-installation-v1",
      pluginRoot: "./app-builder",
      releaseArchive: release.archive,
    },
    null,
    2,
  )}\n`,
);
console.log(`Installed portable ${client} harness at ${clientRoot}`);
