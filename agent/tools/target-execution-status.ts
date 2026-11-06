import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectTargetExecutionReadiness } from "@/lib/agent/target-execution";
import { appBuilderWorkflowState, assertUpstreamMutationAllowed } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Inspect the selected plan and report execution diagnostics without running its build commands. Version and cache observations are diagnostic information, not a substitute for executing the repository's commands. This does not approve building or publishing changes.",
  async execute({ expectedProposalDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "target execution readiness inspection");
    if (
      ![
        "planned",
        "apply_failed",
        "applied",
        "validation_pending",
        "validation_failed",
        "validated",
        "reviewed",
      ].includes(current.phase)
    ) {
      throw new Error(
        "Derive a canonical AppSpec-bound proposal before checking target command readiness.",
      );
    }
    return await inspectTargetExecutionReadiness({
      expectedProposalDigest,
      sandbox: await ctx.getSandbox(),
      state: current,
    });
  },
  inputSchema: z.object({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
