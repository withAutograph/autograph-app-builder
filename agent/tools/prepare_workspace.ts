import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { prepareSupportedSandboxWorkspace } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Materialize an already-reviewed eligible source tree inside this Eve session's isolated workspace. This starts workspace execution and requires approval bound to the source SHA and eligibility digest.",
  inputSchema: z.object({
    path: z.string().min(1),
    expectedSha: z.string().regex(/^[0-9a-f]{40}$/u),
    expectedEligibilityDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute({ path, expectedSha, expectedEligibilityDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    const currentWorkspace = workflowWorkspace(current);
    if (
      currentWorkspace !== undefined &&
      (currentWorkspace.sourceSha !== expectedSha ||
        currentWorkspace.eligibilityDigest !== expectedEligibilityDigest)
    )
      throw new Error("This Eve session already owns a different workspace.");
    const workspace = await prepareSupportedSandboxWorkspace(
      path,
      expectedSha,
      expectedEligibilityDigest,
      await ctx.getSandbox(),
      ctx.callId,
    );
    appBuilderWorkflowState.update(() =>
      current.phase === "empty" || current.phase === "prepared"
        ? {
            version: 1,
            phase: "prepared",
            preparedByCallId: ctx.callId,
            workspace,
          }
        : current,
    );
    return workspace;
  },
});
