import { defineTool } from "eve/tools";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { deriveNormalizedChangeSet } from "@/lib/repository/reviewed-change-set";

export async function exactNormalizedChangeSet(input: {
  state: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "validated" | "reviewed" }
  >;
}): Promise<ReturnType<typeof deriveNormalizedChangeSet>> {
  return deriveNormalizedChangeSet(
    input.state.applyReceipt,
    input.state.validationReceipt,
    input.state.proposal.contractDigest,
    input.state.sourceReceipt.contractDigest,
  );
}

export default defineTool({
  description:
    "Summarize the reviewed changes after repository validation succeeds. This never publishes or changes an external repository.",
  inputSchema: z.object({}),
  async execute(_input) {
    void _input;
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed")
      throw new Error(
        "Run the repository validation before reviewing its changes.",
      );
    const changeSet = await exactNormalizedChangeSet({ state });
    return { ...changeSet, reviewed: state.phase === "reviewed" };
  },
});
