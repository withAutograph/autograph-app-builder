import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
  overlayChanges,
  reviewedOverlayTreeDigest,
} from "@/lib/repository/target-apply";
import type { OverlayChange } from "@/lib/repository/target-apply";
import { deriveNormalizedChangeSet } from "@/lib/repository/reviewed-change-set";
import { hasTestCapability } from "@/lib/testing/test-capability";
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

export const changedAppTextPaths = (changes: readonly ChangePath[], appId: string): string[] =>
  changes
    .filter(
      ({ path, kind }) =>
        kind !== "deleted" && path.startsWith(`apps/${appId}/`) && isCandidateExportTextPath(path),
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

export const changedAppTextExport = async (
  changes: readonly ChangePath[],
  appId: string,
  readText: (path: string) => PromiseLike<string | null>,
  options: {
    cursor?: { digest: string; offsetBytes: number; path: string };
    envelope?: ChangeSetExportEnvelope;
  } = {},
) => {
  const appChanges = changes.filter(({ path }) => path.startsWith(`apps/${appId}/`));
  const paths = changedAppTextPaths(changes, appId);
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
  const changes = reviewableChanges(
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
  return deriveNormalizedChangeSet(
    {
      ...input.state.applyReceipt,
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
  cursor?: { digest: string; offsetBytes: number; path: string };
}) => {
  const observed = hasTestCapability("simulated-target")
    ? await inspectFixtureApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
        input.state.appSpec.appId,
      )
    : await inspectApplyOverlay(input.sandbox, input.state.applyReceipt.applyRoot);
  const changes = reviewableChanges(
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
  // A complete app checkout can include tens of megabytes of unchanged schema history.
  const exported = await changedAppTextExport(
    changes,
    input.state.appSpec.appId,
    (path) =>
      input.sandbox.readTextFile({
        path: `${input.state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "")}/${path}`,
      }),
    { cursor: input.cursor, envelope: input.envelope },
  );
  return {
    changes,
    ...exported,
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
    const exported = input.includeContent
      ? await exportAppliedTextFiles({
          cursor: input.contentCursor,
          envelope: changeSet,
          sandbox,
          state,
        })
      : undefined;
    return {
      ...changeSet,
      reviewed: state.phase === "reviewed",
      ...(exported === undefined
        ? {}
        : { exportFiles: exported.exportFiles, exportOmissions: exported.exportOmissions }),
    };
  },
  inputSchema: z.strictObject({
    contentCursor: z
      .strictObject({
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
        offsetBytes: z.number().int().nonnegative(),
        path: z.string().min(1),
      })
      .optional(),
    includeContent: z.boolean().default(false),
  }),
});
