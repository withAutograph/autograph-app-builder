import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  plannedProposalForExecution,
  targetExecutionBlockers,
} from "@/lib/agent/target-execution";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";
import {
  configuredToolchainImage,
  requiredToolVersions,
  toolVersionMatches,
} from "@/lib/sandbox/toolchain";

const commands = ["bash", "git", "mise", "bun", "node", "pnpm"] as const;

export default defineTool({
  description:
    "Verify whether the exact planned proposal is eligible for a future typed target command. This tool only rechecks durable receipts and a fixed tool allowlist; it never executes target-owned commands.",
  inputSchema: z.object({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedProposalDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    const proposal = plannedProposalForExecution(
      current,
      expectedProposalDigest,
    );
    if (current.phase !== "planned")
      throw new Error(
        "Derive a canonical AppSpec-bound proposal before checking target command readiness.",
      );
    const sandbox = await ctx.getSandbox();
    const observed = await inspectPreparedSandboxWorkspace(sandbox);
    if (
      observed.state !== "prepared" ||
      JSON.stringify(observed.workspace) !== JSON.stringify(current.workspace)
    )
      throw new Error(
        "The prepared workspace receipt changed before execution readiness.",
      );
    const tools = await Promise.all(
      commands.map(async (command) => {
        const location = await sandbox.run({
          command: `command -v ${command}`,
        });
        if (location.exitCode !== 0)
          return { command, available: false as const, version: "" };
        const version = await sandbox.run({ command: `${command} --version` });
        return {
          command,
          available: true as const,
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
      const observedTool = tools.find((tool) => tool.command === command);
      return {
        command,
        expected: requiredToolVersions[command].source,
        version: observedTool?.version ?? "",
        matches:
          observedTool?.available === true &&
          toolVersionMatches(command, observedTool.version),
      };
    });
    const toolchainReady =
      image !== undefined && required.every((tool) => tool.matches);
    const blockers = targetExecutionBlockers({
      imageConfigured: image !== undefined,
      toolchainReady,
    });
    return {
      proposalDigest: proposal.digest,
      targetCommandReady: blockers.length === 0,
      blockers,
      required,
    };
  },
});
