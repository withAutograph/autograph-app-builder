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

export const isCandidateExportTextPath = (path: string): boolean => {
  if (/(?:^|\/)(?:\.next|node_modules|dist|coverage|storybook-static)(?:\/|$)/u.test(path)) {
    return false;
  }
  return /(?:^|\/)(?:Dockerfile|\.gitignore)$|\.(?:[cm]?[jt]sx?|css|mdx?|json|toml|ya?ml|cue|sql|pkl)$/u.test(
    path,
  );
};

export const exactNormalizedChangeSet = async (input: {
  state: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "validated" | "reviewed" }
  >;
  sandbox: SandboxSession;
}) => {
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
      changedContentDigest: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
      changes,
      postTree: observed.files,
      postTreeDigest: observed.treeDigest,
    },
    input.state.validationReceipt,
    input.state.proposal.contractDigest,
    input.state.sourceReceipt.contractDigest,
  );
};

const exportAppliedTextFiles = async (input: {
  state: Extract<
    ReturnType<typeof appBuilderWorkflowState.get>,
    { phase: "validated" | "reviewed" | "validation_failed" }
  >;
  sandbox: SandboxSession;
}) => {
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
  const appPrefix = `apps/${input.state.appSpec.appId}/`;
  const appFiles = observed.files.filter((file) => file.path.startsWith(appPrefix));
  const textFiles = appFiles.filter((file) => isCandidateExportTextPath(file.path));
  return {
    changes,
    exportFiles: await Promise.all(
      textFiles.map(async (file) => ({
        content: await input.sandbox.readTextFile({
          path: `${input.state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "")}/${file.path}`,
        }),
        path: file.path,
      })),
    ),
    exportOmissions: appFiles
      .filter((file) => !textFiles.includes(file))
      .map((file) => ({ path: file.path, reason: "non-text artifact" })),
  };
};

export default defineTool({
  description:
    "Summarize changes after repository validation succeeds, or export the applied source for diagnosis when validation fails. A failed change set is explicitly unreviewed and cannot be accepted. This never publishes or changes an external repository.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "validated" &&
      state.phase !== "reviewed" &&
      state.phase !== "validation_failed"
    )
      throw new Error("Run the repository validation before reviewing its changes.");
    const sandbox = await ctx.getSandbox();
    if (state.phase === "validation_failed") {
      if (!input.includeContent)
        return {
          reviewed: false,
          status: "validation_failed" as const,
          validationFailure: state.validationFailure,
        };
      return {
        ...(await exportAppliedTextFiles({ sandbox, state })),
        reviewed: false,
        status: "validation_failed" as const,
        validationFailure: state.validationFailure,
      };
    }
    const changeSet = await exactNormalizedChangeSet({ sandbox, state });
    const exported = input.includeContent
      ? await exportAppliedTextFiles({ sandbox, state })
      : undefined;
    return {
      ...changeSet,
      reviewed: state.phase === "reviewed",
      ...(exported === undefined
        ? {}
        : { exportFiles: exported.exportFiles, exportOmissions: exported.exportOmissions }),
    };
  },
  inputSchema: z.strictObject({ includeContent: z.boolean().default(false) }),
});
