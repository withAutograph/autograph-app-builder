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

export function isCandidateExportTextPath(path: string): boolean {
  return /(?:^|\/)(?:Dockerfile|\.gitignore)$|\.(?:[cm]?[jt]sx?|css|mdx?|json|toml|ya?ml|cue|sql)$/u.test(
    path,
  );
}

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
    : await inspectApplyOverlay(input.sandbox, input.state.applyReceipt.applyRoot);
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
      changedContentDigest: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
    },
    input.state.validationReceipt,
    input.state.proposal.contractDigest,
    input.state.sourceReceipt.contractDigest,
  );
}

export default defineTool({
  description:
    "Summarize the reviewed changes after repository validation succeeds. This never publishes or changes an external repository.",
  inputSchema: z.strictObject({ includeContent: z.boolean().default(false) }),
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed")
      throw new Error("Run the repository validation before reviewing its changes.");
    const sandbox = await ctx.getSandbox();
    const changeSet = await exactNormalizedChangeSet({ state, sandbox });
    const changedFiles = changeSet.changes.filter((change) => change.kind !== "deleted");
    const textFiles = changedFiles.filter((change) => isCandidateExportTextPath(change.path));
    const exportFiles = input.includeContent
      ? await Promise.all(
          textFiles.map(async (change) => ({
            path: change.path,
            content: await sandbox.readTextFile({
              path: `${state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "")}/${change.path}`,
            }),
          })),
        )
      : undefined;
    return {
      ...changeSet,
      reviewed: state.phase === "reviewed",
      ...(exportFiles === undefined
        ? {}
        : {
            exportFiles,
            exportOmissions: changedFiles
              .filter((change) => !textFiles.includes(change))
              .map((change) => ({ path: change.path, reason: "non-text artifact" })),
          }),
    };
  },
});
