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

const MAX_EXPORT_FILE_BYTES = 512 * 1024;
const MAX_EXPORT_TOTAL_BYTES = 2 * 1024 * 1024;

export const changedAppTextPaths = (
  changes: readonly { path: string; kind: "added" | "modified" | "deleted" }[],
  appId: string,
): string[] =>
  changes
    .filter(
      ({ path, kind }) =>
        kind !== "deleted" && path.startsWith(`apps/${appId}/`) && isCandidateExportTextPath(path),
    )
    .map(({ path }) => path);

export const boundedChangedAppTextExport = async (
  changes: readonly { path: string; kind: "added" | "modified" | "deleted" }[],
  appId: string,
  readText: (path: string) => PromiseLike<string | null>,
) => {
  const appChanges = changes.filter(({ path }) => path.startsWith(`apps/${appId}/`));
  const exportFiles: { content: string; path: string }[] = [];
  const exportOmissions: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  for (const path of changedAppTextPaths(changes, appId)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- bound the total export in path order.
    const content = await readText(path);
    const size = content === null ? 0 : Buffer.byteLength(content, "utf-8");
    if (
      content === null ||
      size > MAX_EXPORT_FILE_BYTES ||
      totalBytes + size > MAX_EXPORT_TOTAL_BYTES
    ) {
      exportOmissions.push({
        path,
        reason:
          content === null
            ? "changed text file could not be read"
            : `changed text file exceeds the bounded review export (${size} bytes); inspect it separately before publication`,
      });
      continue;
    }
    totalBytes += size;
    exportFiles.push({ content, path });
  }
  return {
    exportFiles,
    exportOmissions: [
      ...exportOmissions,
      ...appChanges
        .filter(({ path, kind }) => kind !== "deleted" && !isCandidateExportTextPath(path))
        .map(({ path }) => ({ path, reason: "changed non-text artifact" })),
    ],
  };
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
  // A complete app checkout can include tens of megabytes of unchanged schema history.
  const bounded = await boundedChangedAppTextExport(changes, input.state.appSpec.appId, (path) =>
    input.sandbox.readTextFile({
      path: `${input.state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "")}/${path}`,
    }),
  );
  return {
    changes,
    ...bounded,
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
    ) {
      throw new Error("Run the repository validation before reviewing its changes.");
    }
    const sandbox = await ctx.getSandbox();
    if (state.phase === "validation_failed") {
      if (!input.includeContent) {
        return {
          reviewed: false,
          status: "validation_failed" as const,
          validationFailure: state.validationFailure,
        };
      }
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
