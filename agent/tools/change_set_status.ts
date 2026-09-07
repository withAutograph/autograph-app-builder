import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
  overlayChanges,
} from "@/lib/repository/target-apply";
import { deriveNormalizedChangeSet } from "@/lib/repository/reviewed-change-set";
import { hasTestCapability } from "@/lib/testing/test-capability";

export async function exactNormalizedChangeSet(input: {
  state: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "validated" | "reviewed" }
  >;
  sandbox: SandboxSession;
}): Promise<ReturnType<typeof deriveNormalizedChangeSet>> {
  const observed = hasTestCapability("simulated-target")
    ? await inspectFixtureApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
        input.state.appSpec.appId,
      )
    : await inspectApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
      );
  const changes = overlayChanges(
    {
      files: input.state.applyReceipt.preTree,
      treeDigest: input.state.applyReceipt.preTreeDigest,
    },
    observed,
  );
  return deriveNormalizedChangeSet(
    {
      ...input.state.applyReceipt,
      postTree: observed.files,
      postTreeDigest: observed.treeDigest,
      changes,
      changedContentDigest: createHash("sha256")
        .update(JSON.stringify(changes))
        .digest("hex"),
    },
    input.state.validationReceipt,
    input.state.proposal.contractDigest,
    input.state.sourceReceipt.contractDigest,
  );
}

export default defineTool({
  description:
    "Summarize the reviewed changes after repository validation succeeds. This never publishes or changes an external repository.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    void _input;
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed")
      throw new Error(
        "Run the repository validation before reviewing its changes.",
      );
    const changeSet = await exactNormalizedChangeSet({
      state,
      sandbox: await ctx.getSandbox(),
    });
    return { ...changeSet, reviewed: state.phase === "reviewed" };
  },
});
