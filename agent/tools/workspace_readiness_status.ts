import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  sha256,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Report that the writable Sandbox checkout is ready for normal repository planning commands. Cache and tool observations are diagnostics only: the planner runs the repository commands and handles their actual result.",
  inputSchema: z.object({}),
  async execute(_input) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace readiness inspection");
    if (current.phase === "empty")
      throw new Error(
        "Prepare an eligible repository before checking workspace readiness.",
      );
    const receipt = {
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      sourceReceiptDigest: current.sourceReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      execution: "direct-sandbox-commands",
    };
    return {
      ...receipt,
      workspaceReadinessDigest: sha256(JSON.stringify(receipt)),
      toolchainReady: true,
      dependencyPreparation: "run-on-plan",
      blockers: [],
    };
  },
});
