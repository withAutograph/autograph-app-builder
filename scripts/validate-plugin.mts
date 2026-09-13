import path from "node:path";
import { validateAgentPluginPackage } from "../lib/plugin/agent-plugin-package";

const rootIndex = process.argv.indexOf("--root");
const pluginRoot = path.resolve(rootIndex === -1 ? "." : process.argv[rootIndex + 1]);
if (rootIndex === -1 || process.argv[rootIndex + 1]) {
  // The option is absent or has a value.
} else
  throw new Error(
    "Usage: pnpm validate:plugin [--root <plugin-directory>] [--artifact] [--release]",
  );
const result = await validateAgentPluginPackage({
  packageKind: process.argv.includes("--artifact") ? "generated-artifact" : "source",
  pluginRoot,
  release: process.argv.includes("--release"),
  repositoryRoot: path.resolve("."),
});
console.log(
  result.packageKind === "source"
    ? `Portable source components for ${result.name} ${result.version} satisfy Agent Plugins ${result.specification} pre-build checks.`
    : `Generated portable Agent Plugin artifact ${result.name} ${result.version} conforms to Agent Plugins ${result.specification}.`,
);
