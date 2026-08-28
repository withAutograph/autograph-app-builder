import { resolve } from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";

const rootIndex = process.argv.indexOf("--root");
const pluginRoot = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : ".");
if (rootIndex >= 0 && !process.argv[rootIndex + 1])
  throw new Error(
    "Usage: pnpm validate:plugin [--root <plugin-directory>] [--artifact] [--release]",
  );
const result = await validateAgentPluginPackage({
  pluginRoot,
  repositoryRoot: resolve("."),
  release: process.argv.includes("--release"),
  packageKind: process.argv.includes("--artifact")
    ? "generated-artifact"
    : "source",
});
console.log(
  result.packageKind === "source"
    ? `Portable source components for ${result.name} ${result.version} satisfy Agent Plugins ${result.specification} pre-build checks.`
    : `Generated portable Agent Plugin artifact ${result.name} ${result.version} conforms to Agent Plugins ${result.specification}.`,
);
