import { resolve } from "node:path";

import {
  buildAgentPluginPackage,
  validateAgentPluginPackage,
} from "../lib/plugin/agent-plugin-package";

const repositoryRoot = resolve(".");
const outputRoot = resolve(
  repositoryRoot,
  ".artifacts/agent-plugin/app-builder"
);
await validateAgentPluginPackage({
  packageKind: "source",
  pluginRoot: repositoryRoot,
  repositoryRoot,
});
await buildAgentPluginPackage({ outputRoot, repositoryRoot });
await validateAgentPluginPackage({
  packageKind: "generated-artifact",
  pluginRoot: outputRoot,
  repositoryRoot,
});
console.log(`Built portable Agent Plugin: ${outputRoot}`);
