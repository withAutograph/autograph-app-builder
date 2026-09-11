import { resolve } from "node:path";
import {
  buildAgentPluginPackage,
  validateAgentPluginPackage,
} from "../lib/plugin/agent-plugin-package";

const repositoryRoot = resolve(".");
const outputRoot = resolve(
  repositoryRoot,
  ".artifacts/agent-plugin/app-builder",
);
await validateAgentPluginPackage({
  pluginRoot: repositoryRoot,
  repositoryRoot,
  packageKind: "source",
});
await buildAgentPluginPackage({ repositoryRoot, outputRoot });
await validateAgentPluginPackage({
  pluginRoot: outputRoot,
  repositoryRoot,
  packageKind: "generated-artifact",
});
console.log(`Built portable Agent Plugin: ${outputRoot}`);
