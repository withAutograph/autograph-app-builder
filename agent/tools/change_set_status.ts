import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";
import { z } from "zod";

import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { appBaselineReviewPreTree } from "@/lib/repository/app-baseline";
import {
  canonicalOverlayFiles,
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
  overlayChanges,
  reviewedOverlayTreeDigest,
} from "@/lib/repository/target-apply";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";
import type { GitHubDestinationReviewReadProgress } from "@/lib/agent/workflow-state";
import type { OverlayChange } from "@/lib/repository/target-apply";
import { deriveNormalizedChangeSet } from "@/lib/repository/reviewed-change-set";
import { hasTestCapability } from "@/lib/testing/test-capability";
import {
  assertGitHubDestinationReviewBinding,
  deriveDestinationChanges,
} from "@/lib/repository/github-destination-review";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import type { SourceKind } from "@/lib/repository/source-receipt";
import { largestUtf8PayloadChunk } from "@/lib/eve/payload-envelope";

const isExistingRepositorySource = (sourceKind: SourceKind): boolean =>
  sourceKind === "existing-repository";

export const isCandidateExportTextPath = (path: string): boolean => {
  if (/(?:^|\/)(?:\.next|node_modules|dist|coverage|storybook-static)(?:\/|$)/u.test(path)) {
    return false;
  }
  return /(?:^|\/)(?:Dockerfile|\.gitignore)$|\.(?:[cm]?[jt]sx?|css|mdx?|json|toml|ya?ml|cue|sql|pkl)$/u.test(
    path,
  );
};

type ChangePath = Pick<OverlayChange, "path" | "kind" | "after">;
type ChangeSetExportEnvelope = ReturnType<typeof deriveNormalizedChangeSet>;
interface ChangeSetExportCursor {
  digest: string;
  offsetBytes: number;
  path: string;
  side?: "before" | "after";
}
interface ExportFile {
  content: string;
  digest: string;
  offsetBytes: number;
  path: string;
}
interface ExportOmission {
  path: string;
  reason: string;
}

const exportTextPathChunk = async (input: {
  contentCursor?: ChangeSetExportCursor;
  cursorIndex: number;
  envelope?: ChangeSetExportEnvelope;
  exportFiles: ExportFile[];
  exportOmissions: ExportOmission[];
  expectedDigest?: string;
  index: number;
  path: string;
  readText: (path: string) => PromiseLike<string | null>;
}): Promise<{
  contentCursor?: ChangeSetExportCursor;
  file?: ExportFile;
  omission?: ExportOmission;
}> => {
  const content = await input.readText(input.path);
  if (content === null) {
    return { omission: { path: input.path, reason: "changed text file could not be read" } };
  }
  const digest = createHash("sha256").update(content, "utf-8").digest("hex");
  if (input.expectedDigest !== undefined && digest !== input.expectedDigest) {
    throw new Error(
      `Reviewed file ${input.path} changed during export. Re-run change_set_status to refresh the review.`,
    );
  }
  const offsetBytes =
    input.index === input.cursorIndex ? (input.contentCursor?.offsetBytes ?? 0) : 0;
  if (
    input.index === input.cursorIndex &&
    input.contentCursor !== undefined &&
    input.contentCursor.digest !== digest
  ) {
    throw new Error(
      `Review export cursor digest does not match ${input.path}. Re-run change_set_status.`,
    );
  }
  if (content.length === 0) {
    return { file: { content, digest, offsetBytes: 0, path: input.path } };
  }
  const contentBytes = Buffer.byteLength(content, "utf-8");
  const chunk = largestUtf8PayloadChunk({
    content,
    makePayload: (chunkContent, nextOffsetBytes) => ({
      ...input.envelope,
      contentCursor:
        nextOffsetBytes < contentBytes
          ? { digest, offsetBytes: nextOffsetBytes, path: input.path }
          : undefined,
      exportFiles: [
        ...input.exportFiles,
        { content: chunkContent, digest, offsetBytes, path: input.path },
      ],
      exportOmissions: input.exportOmissions,
    }),
    offsetBytes,
  });
  return {
    ...(chunk.nextOffsetBytes < contentBytes
      ? {
          contentCursor: { digest, offsetBytes: chunk.nextOffsetBytes, path: input.path },
        }
      : {}),
    file: { content: chunk.content, digest, offsetBytes, path: input.path },
  };
};

export const changedAppTextPaths = (
  changes: readonly ChangePath[],
  appId: string,
  extraPaths: readonly string[] = [],
): string[] =>
  changes
    .filter(
      ({ path, kind }) =>
        kind !== "deleted" &&
        (path.startsWith(`apps/${appId}/`) || extraPaths.includes(path)) &&
        isCandidateExportTextPath(path),
    )
    .map(({ path }) => path);

// An existing-app iteration can stage planning metadata in the overlay. Its
// publication is restricted to the selected app and excludes tooling output
// left by validation or preview. Apply the same scope to review and export.
export const reviewableChanges = <T extends ChangePath>(
  changes: readonly T[],
  appId: string,
  existingApp: boolean,
) =>
  changes.filter(({ path }) => {
    if (
      /(?:^|\/)(?:\.git|\.scratch|\.next|\.turbo|\.vite|node_modules|dist|coverage|storybook-static|target)(?:\/|$)/u.test(
        path,
      ) ||
      /(?:^|\/)next-env\.d\.ts$/u.test(path)
    ) {
      return false;
    }
    return !existingApp || path.startsWith(`apps/${appId}/`);
  });

export const baselineReviewableChanges = <T extends ChangePath>(
  changes: readonly T[],
  appId: string,
): T[] => {
  const allowed = new Set(reviewableChanges(changes, appId, true).map(({ path }) => path));
  allowed.add(`.config/app-specs/${appId}.cue`);
  allowed.add(`.config/app-specs/${appId}.md`);
  return changes.filter(({ path }) => allowed.has(path));
};

export const reviewExportChanges = (
  changes: readonly OverlayChange[],
  side: "before" | "after",
): readonly ChangePath[] => {
  if (side === "after") {
    return changes;
  }
  const oppositeKinds = { added: "deleted", deleted: "added", modified: "modified" } as const;
  return changes.map((change) => ({
    after: change.before,
    kind: oppositeKinds[change.kind],
    path: change.path,
  }));
};

export const assertReviewExportCursorSide = (
  cursor: ChangeSetExportCursor | undefined,
  side: "before" | "after",
): void => {
  if (cursor !== undefined && (cursor.side ?? "after") !== side) {
    throw new Error(
      "The review export cursor belongs to the other content side. Start this side from its first page.",
    );
  }
};

export const destinationReviewReadProgress = (input: {
  previous?: GitHubDestinationReviewReadProgress;
  changeSetDigest: string;
  side: "before" | "after";
  cursor?: ChangeSetExportCursor;
  nextCursor?: ChangeSetExportCursor;
  readable: boolean;
}) => {
  const previous: GitHubDestinationReviewReadProgress =
    input.previous?.changeSetDigest === input.changeSetDigest
      ? input.previous
      : { afterComplete: false, beforeComplete: false, changeSetDigest: input.changeSetDigest };
  const expected = input.side === "before" ? previous.beforeCursor : previous.afterCursor;
  if (
    input.cursor !== undefined &&
    !(["digest", "offsetBytes", "path", "side"] as const).every(
      (key) => input.cursor?.[key] === expected?.[key],
    )
  ) {
    throw new Error(
      "Resume the destination diff from its saved cursor or start this side from its first page.",
    );
  }
  const priorReadable = input.side === "before" ? previous.beforeReadable : previous.afterReadable;
  const readable = input.readable && (input.cursor === undefined || priorReadable !== false);
  return {
    ...previous,
    ...(input.side === "before"
      ? {
          beforeComplete: readable && input.nextCursor === undefined,
          beforeCursor: input.nextCursor,
          beforeReadable: readable,
        }
      : {
          afterComplete: readable && input.nextCursor === undefined,
          afterCursor: input.nextCursor,
          afterReadable: readable,
        }),
  };
};

export const changedAppTextExport = async (
  changes: readonly ChangePath[],
  appId: string,
  readText: (path: string) => PromiseLike<string | null>,
  options: {
    cursor?: { digest: string; offsetBytes: number; path: string };
    envelope?: ChangeSetExportEnvelope;
    extraPaths?: readonly string[];
  } = {},
) => {
  const appChanges = changes.filter(
    ({ path }) => path.startsWith(`apps/${appId}/`) || options.extraPaths?.includes(path) === true,
  );

  const paths = changedAppTextPaths(changes, appId, options.extraPaths);
  const exportFiles: ExportFile[] = [];
  const exportOmissions: ExportOmission[] = appChanges
    .filter(({ path, kind }) => kind !== "deleted" && !isCandidateExportTextPath(path))
    .map(({ path }) => ({ path, reason: "changed non-text artifact" }));
  const cursorIndex = options.cursor === undefined ? 0 : paths.indexOf(options.cursor.path);
  if (options.cursor !== undefined && cursorIndex < 0) {
    throw new Error(
      "The review export cursor is stale because its path is no longer in the change set.",
    );
  }
  const expectedDigests = new Map(
    changes.flatMap((change) =>
      change.kind === "deleted" || change.after === undefined
        ? []
        : [[change.path, change.after.digest] as const],
    ),
  );
  for (const [offset, path] of paths.slice(cursorIndex).entries()) {
    const index = cursorIndex + offset;
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve reviewed path order while reading files.
    const exported = await exportTextPathChunk({
      contentCursor: options.cursor,
      cursorIndex,
      envelope: options.envelope,
      expectedDigest: expectedDigests.get(path),
      exportFiles,
      exportOmissions,
      index,
      path,
      readText,
    });
    if (exported.omission !== undefined) {
      exportOmissions.push(exported.omission);
    }
    if (exported.file !== undefined) {
      exportFiles.push(exported.file);
    }
    if (exported.contentCursor !== undefined) {
      return {
        contentCursor: exported.contentCursor,
        exportFiles,
        exportOmissions,
      };
    }
  }
  return { exportFiles, exportOmissions };
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
  const baseline = appBaselineState.get();
  const destination = input.state.githubDestinationReview;
  if (destination !== undefined) {
    assertGitHubDestinationReviewBinding(destination, {
      applyDigest: input.state.applyReceipt.digest,
      postTreeDigest: reviewedOverlayTreeDigest(
        observed,
        input.state.appSpec.appId,
        isExistingRepositorySource(input.state.sourceReceipt.sourceKind),
      ),
      validationDigest: input.state.validationReceipt.digest,
    });
  }
  const selectedBaseline =
    baseline?.receipt?.appId === input.state.appSpec.appId ? baseline : undefined;
  let { preTree } = input.state.applyReceipt;
  if (destination !== undefined) {
    preTree = [...destination.preTree];
  } else if (selectedBaseline !== undefined) {
    preTree = await appBaselineReviewPreTree(
      input.sandbox,
      selectedBaseline.selection,
      input.state.applyReceipt.preTree,
    );
  }
  const completeChanges =
    destination === undefined
      ? overlayChanges(
          { files: preTree, treeDigest: input.state.applyReceipt.preTreeDigest },
          observed,
        )
      : deriveDestinationChanges(destination, observed);
  const changes =
    selectedBaseline === undefined
      ? reviewableChanges(
          completeChanges,
          input.state.appSpec.appId,
          isExistingRepositorySource(input.state.sourceReceipt.sourceKind),
        )
      : baselineReviewableChanges(completeChanges, input.state.appSpec.appId);
  return deriveNormalizedChangeSet(
    {
      ...input.state.applyReceipt,
      ...(selectedBaseline === undefined && destination === undefined
        ? {}
        : {
            preTree,
            preTreeDigest: createHash("sha256")
              .update(JSON.stringify(canonicalOverlayFiles(preTree)))
              .digest("hex"),
          }),
      changedContentDigest: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
      changes,
      postTree: observed.files,
      postTreeDigest: reviewedOverlayTreeDigest(
        observed,
        input.state.appSpec.appId,
        isExistingRepositorySource(input.state.sourceReceipt.sourceKind),
      ),
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
  envelope?: ChangeSetExportEnvelope;
  cursor?: ChangeSetExportCursor;
  contentSide?: "before" | "after";
  readBeforeText?: (path: string) => Promise<string | null>;
}) => {
  const observed = hasTestCapability("simulated-target")
    ? await inspectFixtureApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
        input.state.appSpec.appId,
      )
    : await inspectApplyOverlay(input.sandbox, input.state.applyReceipt.applyRoot);
  const changes =
    input.envelope?.changes ??
    reviewableChanges(
      overlayChanges(
        {
          files: input.state.applyReceipt.preTree,
          treeDigest: input.state.applyReceipt.preTreeDigest,
        },
        observed,
      ),
      input.state.appSpec.appId,
      isExistingRepositorySource(input.state.sourceReceipt.sourceKind),
    );
  const before = input.contentSide === "before";
  const destination = input.state.githubDestinationReview;
  if (before && destination === undefined) {
    throw new Error("Prepare the GitHub destination review before exporting its before content.");
  }
  assertReviewExportCursorSide(input.cursor, input.contentSide ?? "after");
  const exportChanges = reviewExportChanges(changes, input.contentSide ?? "after");
  // A complete app checkout can include tens of megabytes of unchanged schema history.
  const exported = await changedAppTextExport(
    exportChanges,
    input.state.appSpec.appId,
    async (path) => {
      if (before && destination !== undefined) {
        if (input.readBeforeText === undefined) {
          throw new Error(
            "The GitHub runtime does not support immutable destination content reads.",
          );
        }
        return await input.readBeforeText(path);
      }
      return await input.sandbox.readTextFile({
        path: `${input.state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "")}/${path}`,
      });
    },
    {
      cursor: input.cursor,
      envelope: input.envelope,
      extraPaths: changes
        .filter(
          ({ path }) =>
            path === `.config/app-specs/${input.state.appSpec.appId}.cue` ||
            path === `.config/app-specs/${input.state.appSpec.appId}.md`,
        )
        .map(({ path }) => path),
    },
  );
  return {
    absentPaths: changes
      .filter((change) => (before ? change.kind === "added" : change.kind === "deleted"))
      .map((change) => change.path),
    changes,
    ...exported,
    contentCursor:
      exported.contentCursor === undefined
        ? undefined
        : {
            ...exported.contentCursor,
            side: input.contentSide ?? "after",
          },
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
        ...(await exportAppliedTextFiles({ cursor: input.contentCursor, sandbox, state })),
        reviewed: false,
        status: "validation_failed" as const,
        validationFailure: state.validationFailure,
      };
    }
    const changeSet = await exactNormalizedChangeSet({ sandbox, state });
    const destination = state.githubDestinationReview;
    const runtime =
      input.includeContent && input.contentSide === "before"
        ? await githubPublicationRuntimeForSession(ctx.session.auth)
        : undefined;
    const exported = input.includeContent
      ? await exportAppliedTextFiles({
          contentSide: input.contentSide,
          cursor: input.contentCursor,
          envelope: changeSet,
          readBeforeText:
            runtime?.readDraftDestinationFile === undefined || destination === undefined
              ? undefined
              : async (path) => {
                  const file = await runtime.readDraftDestinationFile?.({
                    binding: destination,
                    path,
                  });
                  if (file === undefined) {
                    return null;
                  }
                  if (file === null) {
                    return null;
                  }
                  return Buffer.from(file.bytes).toString("utf-8");
                },
          sandbox,
          state,
        })
      : undefined;
    if (destination !== undefined && exported !== undefined) {
      const progress = destinationReviewReadProgress({
        changeSetDigest: changeSet.digest,
        cursor: input.contentCursor,
        nextCursor: exported.contentCursor,
        previous: state.githubDestinationReviewRead,
        readable: exported.exportOmissions.every(
          (omission) => omission.reason === "changed non-text artifact",
        ),
        side: input.contentSide,
      });
      updateExactWorkflow({
        expected: state,
        operation: "destination diff content read",
        transition: (latest) => ({ ...latest, githubDestinationReviewRead: progress }),
      });
    }
    return {
      ...changeSet,
      ...(destination === undefined
        ? {}
        : {
            publicationDestination: {
              branch: destination.repository.defaultBranch,
              headSha: destination.repository.headSha,
              headTree: destination.repository.headTree,
              repository: `${destination.repository.owner}/${destination.repository.name}`,
            },
          }),
      reviewed: state.phase === "reviewed",
      ...(exported === undefined
        ? {}
        : {
            absentPaths: exported.absentPaths,
            contentCursor: exported.contentCursor,
            contentSide: input.contentSide,
            exportFiles: exported.exportFiles,
            exportOmissions: exported.exportOmissions,
          }),
    };
  },
  inputSchema: z.strictObject({
    contentCursor: z
      .strictObject({
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
        offsetBytes: z.number().int().nonnegative(),
        path: z.string().min(1),
        side: z.enum(["before", "after"]).optional(),
      })
      .optional(),
    contentSide: z.enum(["before", "after"]).default("after"),
    includeContent: z.boolean().default(false),
  }),
});
