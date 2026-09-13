import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  sha256,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Report that the writable Sandbox checkout is ready for normal repository planning commands. Cache and tool observations are diagnostics only: the planner runs the repository commands and handles their actual result.",
  execute() {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace readiness inspection");
    if (current.phase === "empty")
      throw new Error("Prepare an eligible repository before checking workspace readiness.");
    const receipt = {
      eligibilityDigest: current.workspace.eligibilityDigest,
      execution: "direct-sandbox-commands",
      sourceReceiptDigest: current.sourceReceipt.digest,
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      workspaceDigest: current.workspace.workspaceDigest,
    };
    return {
      ...receipt,
      blockers: [],
      dependencyPreparation: "run-on-plan",
      toolchainReady: true,
      workspaceReadinessDigest: sha256(JSON.stringify(receipt)),
    };
  },
  inputSchema: z.object({}),
});
