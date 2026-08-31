import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  sha256,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";
import { SOURCE_RECEIPT_VERSION } from "@/lib/repository/source-receipt";
import {
  assertExactDependencyTargetBinding,
  dependencyCacheReceiptDigest,
  dependencyTargetForWorkspace,
  inspectDependencyCache,
} from "@/lib/repository/dependency-cache";
import {
  configuredToolchainImage,
  requiredToolVersions,
  toolVersionMatches,
} from "@/lib/sandbox/toolchain";
import { sandboxBackendPlan } from "@/lib/sandbox/backend";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { targetExecutionBinding } from "@/lib/repository/target-planning";

const commands = ["git", "mise", "bun"] as const;

export default defineTool({
  description:
    "Verify the exact prepared workspace and fixed immutable toolchain before planning. It only inspects receipts and fixed command versions; it never executes a target-owned command.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace readiness inspection");
    if (current.phase === "empty")
      throw new Error(
        "Prepare an eligible repository before checking workspace readiness.",
      );
    const sandbox = await ctx.getSandbox();
    await inspectSourceBoundSandboxWorkspace({
      sandbox,
      receipt: current.sourceReceipt,
      expectedWorkspace: current.workspace,
    });
    const observedTools = await Promise.all(
      commands.map(async (command) => {
        const location = await sandbox.run({
          command: `command -v ${command}`,
        });
        if (location.exitCode !== 0) return { command, version: "" };
        const version = await sandbox.run({ command: `${command} --version` });
        return {
          command,
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
        ? await inspectDependencyCache(
            sandbox,
            process.env,
            current.workspace,
            current.sourceReceipt.version === SOURCE_RECEIPT_VERSION,
          ).catch(() => undefined)
        : undefined;
    let sourceTargetReady = false;
    if (cache !== undefined) {
      try {
        assertExactDependencyTargetBinding({
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          cache,
          ...(current.phase === "dependencies_prepared" ||
          current.phase === "identity_resolved" ||
          current.phase === "planned" ||
          current.phase === "apply_failed" ||
          current.phase === "applied" ||
          current.phase === "validation_pending" ||
          current.phase === "validation_failed" ||
          current.phase === "validated" ||
          current.phase === "reviewed" ||
          current.phase === "publication_pending" ||
          current.phase === "publication_failed" ||
          current.phase === "published_local" ||
          current.phase === "branch_publication_pending" ||
          current.phase === "branch_publication_failed" ||
          current.phase === "published_branch_worktree" ||
          current.phase === "fresh_bootstrap_pending" ||
          current.phase === "fresh_bootstrap_failed" ||
          current.phase === "published_fresh_bootstrap"
            ? { dependencyReceipt: current.dependencyReceipt }
            : {}),
        });
        sourceTargetReady = true;
      } catch {
        sourceTargetReady = false;
      }
    }
    const required = (
      Object.keys(requiredToolVersions) as Array<
        keyof typeof requiredToolVersions
      >
    ).map((command) => {
      const version =
        observedTools.find((tool) => tool.command === command)?.version ?? "";
      return {
        command,
        expected: requiredToolVersions[command].source,
        version,
        matches: toolVersionMatches(command, version),
      };
    });
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
    const toolchainReady =
      backend.blockers.length === 0 &&
      execution !== undefined &&
      cache !== undefined &&
      sourceTargetReady &&
      required.every((tool) => tool.matches);
    const dependencyTarget =
      cache === undefined
        ? undefined
        : dependencyTargetForWorkspace(cache, current.workspace);
    const receipt = {
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      sourceReceiptDigest: current.sourceReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution?.imageDigest ?? image ?? "unconfigured",
      dependencyCacheDigest:
        cache === undefined
          ? "unverified"
          : dependencyCacheReceiptDigest(cache),
      targetSha: dependencyTarget?.sha ?? "unverified",
      targetTree: dependencyTarget?.tree ?? "unverified",
      required,
    };
    return {
      ...receipt,
      workspaceReadinessDigest: sha256(JSON.stringify(receipt)),
      toolchainReady,
      blockers: toolchainReady
        ? []
        : [
            ...backend.blockers,
            ...(sourceTargetReady
              ? []
              : [
                  "The prepared source does not match the immutable dependency target.",
                ]),
            "The immutable sandbox image and exact Git, mise, and Bun receipt are not ready.",
          ],
    };
  },
});
