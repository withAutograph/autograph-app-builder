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
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const tools = await Promise.all(
      commands.map(async (command) => {
        const location = await sandbox.run({
          command: `command -v ${command}`,
        });
        if (location.exitCode !== 0)
          return { command, available: false as const };
        const version = await sandbox.run({ command: `${command} --version` });
        return {
          command,
          available: true as const,
          path: location.stdout.trim(),
          version:
            (version.stdout.trim() || version.stderr.trim()).split("\n")[0] ??
            "",
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
        ? await inspectDependencyCache(sandbox).catch(() => undefined)
        : undefined;
    const execution =
      cache === undefined
        ? undefined
        : (() => {
            try {
              return targetExecutionBinding(cache);
            } catch {
              return undefined;
            }
          })();
    const required = (
      Object.keys(requiredToolVersions) as Array<
        keyof typeof requiredToolVersions
      >
    ).map((command) => {
      const observed = tools.find((tool) => tool.command === command);
      return {
        command,
        expected: requiredToolVersions[command].source,
        available: observed?.available === true,
        version: observed?.available === true ? observed.version : "",
        matches:
          observed?.available === true &&
          toolVersionMatches(command, observed.version),
      };
    });
    return {
      sandboxId: sandbox.id,
      backend: backend.kind,
      backendBlockers: backend.blockers,
      imageConfiguration:
        execution === undefined ? "unconfigured" : "configured",
      toolchainReady:
        execution !== undefined &&
        cache !== undefined &&
        required.every((tool) => tool.matches),
      dependencyCacheDigest:
        cache === undefined
          ? "unverified"
          : dependencyCacheReceiptDigest(cache),
      required,
      tools,
    };
  },
});
