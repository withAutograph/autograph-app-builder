import { defineTool } from "eve/tools";
import { z } from "zod";

import { sha256, appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";
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
      image !== undefined && required.every((tool) => tool.matches);
    const receipt = {
      sourceSha: current.workspace.sourceSha,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: image ?? "unconfigured",
      required,
    };
    return {
      ...receipt,
      workspaceReadinessDigest: sha256(JSON.stringify(receipt)),
      toolchainReady,
      blockers: toolchainReady
        ? []
        : [
            "The immutable sandbox image and exact Git, mise, and Bun receipt are not ready.",
          ],
    };
  },
});
