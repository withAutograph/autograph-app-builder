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
import { readChangeSetReviewPage } from "@/lib/agent/change-set-review-pages";
import type { ChangeSetReviewCursor } from "@/lib/agent/change-set-review-pages";
import { checkedNativeToolResult, largestUtf8PayloadChunk } from "@/lib/eve/payload-envelope";
import { readCurrentOwnedReviewDetails } from "@/lib/agent/review-detail-pages";
import type { SourceKind } from "@/lib/repository/source-receipt";

const isExistingRepositorySource = (sourceKind: SourceKind): boolean =>
  sourceKind === "existing-repository";
const READ_PROGRESS_VIEW = "read-progress";
const NEXT_PAGE_VIEW = "next-page";

export const selectAppBaselineForReview = <
  T extends
    | {
        receipt?: { appId: string };
      }
    | undefined,
>(
  baseline: T,
  appId: string,
): T | undefined => (baseline?.receipt?.appId === appId ? baseline : undefined);

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
type ChangeSetExportCursor = ChangeSetReviewCursor;
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
  includePlanningSpecs = true,
): T[] => {
  const allowed = new Set(reviewableChanges(changes, appId, true).map(({ path }) => path));
  if (includePlanningSpecs) {
    allowed.add(`.config/app-specs/${appId}.cue`);
    allowed.add(`.config/app-specs/${appId}.md`);
  }
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
    !(["digest", "offsetBytes", "path", "side", "changeIndex", "changeSetDigest"] as const).every(
      (key) => input.cursor?.[key] === expected?.[key],
    )
  ) {
    throw new Error(
      "Resume the destination diff from its saved cursor or start this side from its first page. Use change_set_status with view=read-progress to recover the saved next-call arguments.",
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

/** Read saved coverage only for the freshly derived current destination diff. */
export const destinationReviewReadStatus = (input: {
  previous?: GitHubDestinationReviewReadProgress;
  changeSetDigest: string;
}) => {
  const progress =
    input.previous?.changeSetDigest === input.changeSetDigest ? input.previous : undefined;
  const sideStatus = (side: "before" | "after") => {
    const complete =
      (side === "before" ? progress?.beforeComplete : progress?.afterComplete) ?? false;
    const readable =
      (side === "before" ? progress?.beforeReadable : progress?.afterReadable) ?? null;
    return {
      complete,
      nextCall: complete
        ? null
        : {
            contentSide: side,
            view: NEXT_PAGE_VIEW,
          },
      readable,
    };
  };
  return {
    changeSetDigest: input.changeSetDigest,
    sides: { after: sideStatus("after"), before: sideStatus("before") },
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

export const observeNormalizedChangeSet = async (input: {
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
  const selectedBaseline = selectAppBaselineForReview(baseline, input.state.appSpec.appId);
  const includeBaselinePlanningSpecs =
    selectedBaseline?.receipt?.platform.commitSha === input.state.applyReceipt.sourceSha;
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
      : baselineReviewableChanges(
          completeChanges,
          input.state.appSpec.appId,
          includeBaselinePlanningSpecs,
        );
  const changeSet = deriveNormalizedChangeSet(
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
  return { changeSet, observed };
};

export const exactNormalizedChangeSet = async (
  input: Parameters<typeof observeNormalizedChangeSet>[0],
) => {
  const { changeSet } = await observeNormalizedChangeSet(input);
  return changeSet;
};

const currentDestinationProgress = (
  progress: GitHubDestinationReviewReadProgress | undefined,
  changeSetDigest: string,
) => (progress?.changeSetDigest === changeSetDigest ? progress : undefined);

const destinationReviewSide = (
  progress: GitHubDestinationReviewReadProgress | undefined,
  side: "before" | "after",
) => ({
  complete: (side === "before" ? progress?.beforeComplete : progress?.afterComplete) === true,
  cursor: side === "before" ? progress?.beforeCursor : progress?.afterCursor,
});

const assertNextPageInput = (
  input: { view: string; contentCursor?: ChangeSetExportCursor },
  phase: string,
) => {
  if (input.view !== NEXT_PAGE_VIEW) {
    return;
  }
  if (input.contentCursor !== undefined) {
    throw new Error("next-page does not accept contentCursor; use the saved side progress.");
  }
  if (phase === "validation_failed") {
    throw new Error("Run successful repository validation before reading its next page.");
  }
};

const needsBeforeRuntime = (
  input: { view: string; includeContent: boolean; contentSide: "before" | "after" },
  progress: GitHubDestinationReviewReadProgress | undefined,
) => {
  if (input.contentSide !== "before") {
    return false;
  }
  if (input.view === NEXT_PAGE_VIEW) {
    return !destinationReviewSide(progress, input.contentSide).complete;
  }
  return input.includeContent;
};

/** Execute an actual bounded content read before committing its checked receipt. */
export const executeDestinationReviewPage = async (input: {
  page: Parameters<typeof readChangeSetReviewPage>[0];
  previous?: GitHubDestinationReviewReadProgress;
  nextPage?: boolean;
  destination: boolean;
  abortSignal?: AbortSignal;
  commit: (progress: GitHubDestinationReviewReadProgress) => void;
}) => {
  input.abortSignal?.throwIfAborted();
  const { side } = input.page;
  const previous =
    input.previous?.changeSetDigest === input.page.changeSet.digest ? input.previous : undefined;
  if (input.nextPage === true && input.page.cursor !== undefined) {
    throw new Error("next-page does not accept contentCursor; use the saved side progress.");
  }
  if (input.nextPage === true && !input.destination) {
    throw new Error("Prepare the GitHub destination review before reading its next page.");
  }
  const savedSide = destinationReviewSide(previous, side);
  if (input.nextPage === true && savedSide.complete) {
    return checkedNativeToolResult(
      {
        ...destinationReviewReadStatus({ changeSetDigest: input.page.changeSet.digest, previous }),
        alreadyComplete: true,
        contentSide: side,
        reviewReference: {
          digest: input.page.changeSet.digest,
          kind: "current-session-change-set",
          sessionId: input.page.sessionId,
        },
      },
      input.page.metadata,
    );
  }
  const cursor = input.nextPage === true ? savedSide.cursor : input.page.cursor;
  const includeContent = input.nextPage === true ? true : input.page.includeContent;
  const exported = await readChangeSetReviewPage({ ...input.page, cursor, includeContent });
  input.abortSignal?.throwIfAborted();
  const result = checkedNativeToolResult(exported, input.page.metadata);
  if (input.destination && includeContent) {
    const progress = destinationReviewReadProgress({
      changeSetDigest: input.page.changeSet.digest,
      cursor,
      nextCursor: exported.contentCursor,
      previous: input.previous,
      readable: exported.exportOmissions.every(
        (omission) => omission.reason === "changed non-text artifact",
      ),
      side,
    });
    input.abortSignal?.throwIfAborted();
    input.commit(progress);
  }
  return result;
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
    "Read one bounded page of the complete change metadata and optional source content after validation. Prefer view=next-page with contentSide for destination content: it reads actual content from the current session saved cursor without caller contentCursor, and returns alreadyComplete without resetting completed sides. In next-page mode repeat the same minimal call until no cursor remains. In legacy changes mode continue with the entire returned contentCursor verbatim using the same contentSide and includeContent until no cursor remains. Read destination before and after sides from their first page with includeContent=true before acceptance; metadata-only pages do not complete either side. If a cursor is lost or rejected, use view=read-progress to read current saved side coverage and exact nextCall arguments; this status read grants no completion. To restart an unreadable side, omit its contentCursor and read that side completely again. Use view=acceptance after acceptance to read the full saved receipt and product/source evidence as UTF-8-safe JSON chunks using detailCursor and the returned session references. Failed validation remains explicitly unreviewed and cannot be accepted. This never publishes or changes an external repository.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "validated" &&
      state.phase !== "reviewed" &&
      state.phase !== "validation_failed"
    ) {
      throw new Error("Run the repository validation before reviewing its changes.");
    }
    const metadata = {
      callId: ctx.callId,
      toolName: "change_set_status",
      turnId: ctx.session.turn.id,
    };
    if (input.view === "acceptance") {
      if (state.phase !== "reviewed") {
        throw new Error("Accept the current change set before reading its stored review details.");
      }
      return checkedNativeToolResult(
        readCurrentOwnedReviewDetails({
          cursor: input.detailCursor,
          expectedReviewDigest: input.expectedReviewDigest,
          metadata,
          sessionId: ctx.session.id,
          sourceAssessmentBindingDigest: input.sourceAssessmentBindingDigest,
          state,
        }),
        metadata,
      );
    }
    if (state.phase === "validation_failed" && input.view === READ_PROGRESS_VIEW) {
      throw new Error(
        "Run successful repository validation before reading destination review progress.",
      );
    }
    assertNextPageInput(input, state.phase);
    ctx.abortSignal?.throwIfAborted();
    const sandbox = await ctx.getSandbox();
    if (state.phase === "validation_failed") {
      if (!input.includeContent) {
        return {
          reviewed: false,
          status: "validation_failed" as const,
          validationFailure: state.validationFailure,
        };
      }
      return checkedNativeToolResult(
        {
          ...(await exportAppliedTextFiles({ cursor: input.contentCursor, sandbox, state })),
          reviewed: false,
          status: "validation_failed" as const,
          validationFailure: state.validationFailure,
        },
        metadata,
      );
    }
    const changeSet = await exactNormalizedChangeSet({ sandbox, state });
    const destination = state.githubDestinationReview;
    if (input.view === READ_PROGRESS_VIEW) {
      if (destination === undefined) {
        throw new Error("Prepare the GitHub destination review before reading its progress.");
      }
      return checkedNativeToolResult(
        {
          ...destinationReviewReadStatus({
            changeSetDigest: changeSet.digest,
            previous: state.githubDestinationReviewRead,
          }),
          reviewReference: {
            digest: changeSet.digest,
            kind: "current-session-change-set" as const,
            sessionId: ctx.session.id,
          },
        },
        metadata,
      );
    }
    if (input.view === NEXT_PAGE_VIEW && destination === undefined) {
      throw new Error("Prepare the GitHub destination review before reading its next page.");
    }
    const currentProgress = currentDestinationProgress(
      state.githubDestinationReviewRead,
      changeSet.digest,
    );
    const runtime = needsBeforeRuntime(input, currentProgress)
      ? await githubPublicationRuntimeForSession(ctx.session.auth)
      : undefined;
    if (input.includeContent && input.contentSide === "before" && destination === undefined) {
      throw new Error("Prepare the destination review before reading its before content.");
    }
    return await executeDestinationReviewPage({
      abortSignal: ctx.abortSignal,
      commit: (progress) => {
        updateExactWorkflow({
          expected: state,
          operation: "destination diff content read",
          transition: (latest) => ({ ...latest, githubDestinationReviewRead: progress }),
        });
      },
      destination: destination !== undefined,
      nextPage: input.view === NEXT_PAGE_VIEW,
      page: {
        changeSet,
        cursor: input.contentCursor,
        includeContent: input.includeContent,
        isTextPath: isCandidateExportTextPath,
        metadata,
        publicationDestination:
          destination === undefined
            ? undefined
            : {
                branch: destination.repository.defaultBranch,
                headSha: destination.repository.headSha,
                headTree: destination.repository.headTree,
                repository: `${destination.repository.owner}/${destination.repository.name}`,
              },
        readText: async (path) => {
          if (input.contentSide === "before" && destination !== undefined) {
            if (runtime?.readDraftDestinationFile === undefined) {
              throw new Error(
                "The GitHub runtime does not support immutable destination content reads.",
              );
            }
            const file = await runtime.readDraftDestinationFile({ binding: destination, path });
            return file === null ? null : Buffer.from(file.bytes).toString("utf-8");
          }
          return await sandbox.readTextFile({
            path: `${state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "")}/${path}`,
          });
        },
        reviewed: state.phase === "reviewed",
        sessionId: ctx.session.id,
        side: input.contentSide,
      },
      previous: state.githubDestinationReviewRead,
    });
  },
  inputSchema: z.strictObject({
    contentCursor: z
      .strictObject({
        changeIndex: z.number().int().nonnegative().optional(),
        changeSetDigest: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
        offsetBytes: z.number().int().nonnegative(),
        path: z.string().min(1),
        side: z.enum(["before", "after"]).optional(),
      })
      .optional(),
    contentSide: z.enum(["before", "after"]).default("after"),
    detailCursor: z
      .strictObject({
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
        offsetBytes: z.number().int().nonnegative(),
      })
      .optional(),
    expectedReviewDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    includeContent: z.boolean().default(false),
    sourceAssessmentBindingDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    view: z.enum(["changes", "acceptance", READ_PROGRESS_VIEW, NEXT_PAGE_VIEW]).default("changes"),
  }),
});
