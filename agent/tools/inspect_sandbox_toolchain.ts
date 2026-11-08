/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { Sandbox } from "@vercel/sandbox";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { readPrivateComputeProviderState } from "@/lib/sandbox/private-compute-resume";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { inspectSandboxRuntimeResources } from "@/lib/sandbox/runtime-resource-diagnostics";
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

interface SandboxRuntimeResources {
  runtimeResources?: Awaited<ReturnType<typeof inspectSandboxRuntimeResources>>;
}

export default defineTool({
  description:
    "Read advisory Sandbox command availability/version and image/cache observations without installing packages or mutating the workspace. toolchainReady and required.matches describe this inspector's configuration comparisons, not repository access, workspace readiness or build admission. Optional image/cache metadata or version mismatches alone do not require installation, reconnection or source re-resolution. Retain and diagnose actual backend blockers and command failures. computeState=true reads only the saved provider resource metadata and pending journal, without opening or resuming a VM. Set runtimeDiagnostics to read bounded CPU/memory/process-limit facts and installed repository-local Oxlint/Vite+ versions when an actual tool crashes; this never changes resource limits, dependencies, lint rules or build admission.",
  async execute(input, ctx) {
    if (input.computeState === true) {
      const current = appBuilderWorkflowState.get();
      if (!("workspace" in current)) {
        return {
          diagnosticOnly: true,
          status: "no-private-workspace",
          readinessScope: "private-compute-observation",
        };
      }
      await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
      const native = await Sandbox.get({ name: current.workspace.workspaceId, resume: false });
      const computeState = await readPrivateComputeProviderState(native, async () => {
        await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
      });
      return { diagnosticOnly: true, readinessScope: "private-compute-observation", computeState };
    }
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
    const observation = {
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
    const resources: SandboxRuntimeResources = {};
    if (input.runtimeDiagnostics === true) {
      resources.runtimeResources = await inspectSandboxRuntimeResources(sandbox);
    }
    return { ...observation, ...resources };
  },
  inputSchema: z.object({
    computeState: z.boolean().optional(),
    runtimeDiagnostics: z.boolean().optional(),
  }),
});
