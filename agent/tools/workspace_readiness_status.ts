import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  sha256,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";
import {
  assertExactDependencyTargetBinding,
  dependencyCacheReceiptDigest,
  inspectDependencyCache,
} from "@/lib/repository/dependency-cache";
import {
  configuredToolchainImage,
  requiredToolVersions,
  toolVersionMatches,
} from "@/lib/sandbox/toolchain";

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
    const observed = await inspectPreparedSandboxWorkspace(sandbox);
    if (
      observed.state !== "prepared" ||
      JSON.stringify(observed.workspace) !== JSON.stringify(current.workspace)
    )
      throw new Error(
        "The prepared workspace receipt changed before readiness.",
      );
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
    const cache =
      image === undefined
        ? undefined
        : await inspectDependencyCache(
            sandbox,
            process.env,
            current.workspace,
          ).catch(() => undefined);
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
    const toolchainReady =
      image !== undefined &&
      cache !== undefined &&
      sourceTargetReady &&
      required.every((tool) => tool.matches);
    const receipt = {
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: image ?? "unconfigured",
      dependencyCacheDigest:
        cache === undefined
          ? "unverified"
          : dependencyCacheReceiptDigest(cache),
      targetSha: cache?.manifest.target.sha ?? "unverified",
      targetTree: cache?.manifest.target.tree ?? "unverified",
      required,
    };
    return {
      ...receipt,
      workspaceReadinessDigest: sha256(JSON.stringify(receipt)),
      toolchainReady,
      blockers: toolchainReady
        ? []
        : [
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
