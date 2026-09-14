import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  configuredToolchainImage,
  requiredToolVersions,
  toolVersionMatches,
} from "@/lib/sandbox/toolchain";
import { sandboxBackendPlan } from "@/lib/sandbox/backend";
import { hasTestCapability } from "@/lib/testing/test-capability";
import {
  dependencyCacheReceiptDigest,
  inspectDependencyCache,
} from "@/lib/repository/dependency-cache";
import { targetExecutionBinding } from "@/lib/repository/target-planning";

const commands = ["bash", "git", "mise", "bun", "node", "pnpm"] as const;

export default defineTool({
  description:
    "Inspect the fixed sandbox build-tool allowlist without installing packages or mutating the workspace.",
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const tools = await Promise.all(
      commands.map(async (command) => {
        const location = await sandbox.run({
          command: `command -v ${command}`,
        });
        if (location.exitCode !== 0) {
          return { available: false as const, command };
        }
        const version = await sandbox.run({ command: `${command} --version` });
        return {
          available: true as const,
          command,
          path: location.stdout.trim(),
          version: (version.stdout.trim() || version.stderr.trim()).split("\n")[0] ?? "",
        };
      }),
    );
    const image = configuredToolchainImage();
    const backend = sandboxBackendPlan({
      fixture: hasTestCapability("simulated-target"),
      localImageConfigured: image !== undefined,
    });
    const cache =
      backend.blockers.length === 0
        ? await inspectDependencyCache(sandbox).catch(() => globalThis.undefined)
        : undefined;
    const execution =
      cache === undefined
        ? undefined
        : (() => {
            try {
              return targetExecutionBinding(cache);
            } catch {
              return globalThis.undefined;
            }
          })();
    const required = (
      Object.keys(requiredToolVersions) as (keyof typeof requiredToolVersions)[]
    ).map((command) => {
      const observed = tools.find((tool) => tool.command === command);
      return {
        available: observed?.available === true,
        command,
        expected: requiredToolVersions[command].source,
        matches: observed?.available === true && toolVersionMatches(command, observed.version),
        version: observed?.available === true ? observed.version : "",
      };
    });
    return {
      backend: backend.kind,
      backendBlockers: backend.blockers,
      dependencyCacheDigest:
        cache === undefined ? "unverified" : dependencyCacheReceiptDigest(cache),
      imageConfiguration: execution === undefined ? "unconfigured" : "configured",
      required,
      sandboxId: sandbox.id,
      toolchainReady:
        execution !== undefined && cache !== undefined && required.every((tool) => tool.matches),
      tools,
    };
  },
  inputSchema: z.object({}),
});
