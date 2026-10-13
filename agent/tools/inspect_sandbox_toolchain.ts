import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
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

const commands = ["bash", "git", "mise", "bun", "node", "pnpm", "cargo", "rustc"] as const;

export const inspectSandboxCommand = async (
  sandbox: Pick<SandboxSession, "run">,
  command: (typeof commands)[number],
) => {
  const location = await sandbox.run({
    command: `command -v ${command}`,
  });
  if (location.exitCode !== 0) {
    return { available: false as const, command };
  }
  const version = await sandbox.run({ command: `${command} --version` });
  if (version.exitCode !== 0) {
    return { available: false as const, command };
  }
  return {
    available: true as const,
    command,
    path: location.stdout.trim(),
    version: (version.stdout.trim() || version.stderr.trim()).split("\n")[0] ?? "",
  };
};

export default defineTool({
  description:
    "Read advisory Sandbox command availability/version and image/cache observations without installing packages or mutating the workspace. toolchainReady and required.matches describe this inspector's configuration comparisons, not repository access, workspace readiness or build admission. Optional image/cache metadata or version mismatches alone do not require installation, reconnection or source re-resolution. Retain and diagnose actual backend blockers and command failures.",
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const tools = await Promise.all(
      commands.map(async (command) => await inspectSandboxCommand(sandbox, command)),
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
      diagnosticOnly: true,
      imageConfiguration: execution === undefined ? "unconfigured" : "configured",
      note: "Advisory observation only: toolchainReady compares image/cache bindings and configured exact versions, not workspace readiness or build admission. Missing optional metadata or a version mismatch alone is not a build blocker and does not require installation, reconnection, or source re-resolution. backendBlockers and command availability/failure observations retain their factual meaning.",
      readinessScope: "toolchain-configuration-observations",
      required,
      sandboxId: getBuilderSandboxId(sandbox),
      toolchainReady:
        execution !== undefined && cache !== undefined && required.every((tool) => tool.matches),
      tools,
    };
  },
  inputSchema: z.object({}),
});
