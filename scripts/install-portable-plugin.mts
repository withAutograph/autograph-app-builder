import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";

const clients = ["vscode", "cursor", "codex"] as const;
const clientHarnessSuffix = ".client-harness.json";
const pluginRoot = "./app-builder";
const mcpPath = "./app-builder/mcp.json";
const usage = "Usage: --client vscode|cursor|codex --source RELEASE_ROOT --destination DIRECTORY";
const clientInstallExistsMessage = "Client install already exists";
const missingArgumentMessage = "Missing value for";
const appBuilderDirectory = "app-builder";
const harnessSchema = z.record(z.string(), z.unknown());
const releaseSchema = z.object({ archive: z.string() });
const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    throw new Error(usage);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${missingArgumentMessage} ${name}.`);
  }
  return value;
};
const client = argument("--client");
const sourceValue = argument("--source");
const destinationValue = argument("--destination");
const selectedClient = clients.find((candidate) => candidate === client);
if (selectedClient === undefined) {
  throw new Error(usage);
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
  pluginRoot: path.join(source, appBuilderDirectory),
  release: true,
  repositoryRoot: path.resolve("."),
});
const clientRoot = path.join(destination, selectedClient);
try {
  await lstat(clientRoot);
  throw new Error(`${clientInstallExistsMessage}: ${clientRoot}`);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
await mkdir(clientRoot, { mode: 0o700 });
await cp(path.join(source, appBuilderDirectory), path.join(clientRoot, appBuilderDirectory), {
  recursive: true,
});
const harness = harnessSchema.parse(
  JSON.parse(
    await readFile(
      path.join(source, "clients", `${selectedClient}${clientHarnessSuffix}`),
      "utf-8",
    ),
  ),
);
harness.pluginRoot = pluginRoot;
harness.mcp = mcpPath;
await writeFile(
  path.join(clientRoot, "client-harness.json"),
  `${JSON.stringify(harness, null, 2)}\n`,
);
const release = releaseSchema.parse(
  JSON.parse(await readFile(path.join(source, "release-receipt.json"), "utf-8")),
);
await writeFile(
  path.join(clientRoot, "installation-receipt.json"),
  `${JSON.stringify(
    {
      client: selectedClient,
      format: "agent-plugins-offline-installation-v1",
      pluginRoot,
      releaseArchive: release.archive,
    },
    null,
    2,
  )}\n`,
);
console.log(`Installed portable ${selectedClient} harness at ${clientRoot}`);
