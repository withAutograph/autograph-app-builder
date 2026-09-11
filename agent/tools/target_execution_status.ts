import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectTargetExecutionReadiness } from "@/lib/agent/target-execution";
import {
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Inspect the selected plan and report execution diagnostics without running its build commands. Version and cache observations are diagnostic information, not a substitute for executing the repository's commands. This does not approve building or publishing changes.",
  inputSchema: z.object({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedProposalDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(
      current,
      "target execution readiness inspection",
    );
    if (
      current.phase !== "planned" &&
      current.phase !== "apply_failed" &&
      current.phase !== "applied" &&
      current.phase !== "validation_pending" &&
      current.phase !== "validation_failed" &&
      current.phase !== "validated" &&
      current.phase !== "reviewed"
    )
      throw new Error(
        "Derive a canonical AppSpec-bound proposal before checking target command readiness.",
      );
    return inspectTargetExecutionReadiness({
      state: current,
      sandbox: await ctx.getSandbox(),
      expectedProposalDigest,
    });
  },
});
