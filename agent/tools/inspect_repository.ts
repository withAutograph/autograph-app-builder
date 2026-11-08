/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Read and page requested repository files in their caller-visible order. */
import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  fitOutputNativeFrame,
  largestUtf8PayloadChunk,
  serializedNativeActionResultBytes,
} from "@/lib/eve/payload-envelope";
import type { NativeActionResultMetadata } from "@/lib/eve/payload-envelope";
import { z } from "zod";

import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import {
  inspectSupportedRepository,
  prepareDevelopmentSandboxWorkspace,
} from "@/lib/repository/supported-template";

import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import {
  inspectWorkspacePath,
  isWorkspaceDescendant,
  normalizedWorkspacePath,
} from "@/lib/repository/workspace-path-inspection";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { readableAppBaselinePaths } from "@/lib/repository/app-baseline";

const developmentWorkspacePath = "/workspace/repository";
const sandboxOverviewPaths = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "tsconfig.json",
  ".config/typescript/workspace-paths.json",
  "docs/README.md",
] as const;

interface RepositoryInspectionFile {
  content: string;
  path: string;
  offsetBytes?: number;
  restartedFromOffsetBytes?: number;
}
interface RepositoryInspectionContinuation {
  pathIndex: number;
  offsetBytes: number;
}
interface RepositoryInspectionPage {
  files: RepositoryInspectionFile[];
  missingPaths: string[];
  continuation?: RepositoryInspectionContinuation;
}

const repositoryFilePage = (input: {
  content: string | null;
  requestedPath: string;
  index: number;
  pathCount: number;
  offset: number;
  restartedFromOffsetBytes?: number;
  prefix: RepositoryInspectionPage;
  metadata: NativeActionResultMetadata;
}): RepositoryInspectionPage | undefined => {
  const {
    content,
    requestedPath,
    index,
    pathCount,
    offset,
    restartedFromOffsetBytes,
    prefix,
    metadata,
  } = input;
  const contentBytes = content === null ? 0 : Buffer.byteLength(content, "utf-8");
  const makePage = (chunkContent: string, nextOffsetBytes: number): RepositoryInspectionPage => {
    let continuation: RepositoryInspectionContinuation | undefined;
    if (nextOffsetBytes < contentBytes) {
      continuation = { offsetBytes: nextOffsetBytes, pathIndex: index };
    } else if (index + 1 < pathCount) {
      continuation = { offsetBytes: 0, pathIndex: index + 1 };
    }
    const file: RepositoryInspectionFile = {
      content: chunkContent,
      path: requestedPath,
    };
    if (
      !(offset === 0 && nextOffsetBytes === contentBytes && restartedFromOffsetBytes === undefined)
    ) {
      file.offsetBytes = offset;
    }
    if (restartedFromOffsetBytes !== undefined) {
      file.restartedFromOffsetBytes = restartedFromOffsetBytes;
    }
    const page: RepositoryInspectionPage = {
      files: content === null ? prefix.files : [...prefix.files, file],
      missingPaths:
        content === null ? [...prefix.missingPaths, requestedPath] : prefix.missingPaths,
    };
    if (continuation !== undefined) {
      page.continuation = continuation;
    }
    return page;
  };
  const measure = (output: RepositoryInspectionPage) =>
    serializedNativeActionResultBytes(output, metadata);
  const hasPrefix = prefix.files.length + prefix.missingPaths.length > 0;
  if (content === null || offset === contentBytes) {
    const page = makePage("", contentBytes);
    if (hasPrefix && measure(page) > EVE_NATIVE_RESULT_PAGE_BYTES) {
      return undefined;
    }
    return fitOutputNativeFrame(page, metadata, EVE_NATIVE_RESULT_PAGE_BYTES);
  }
  try {
    return largestUtf8PayloadChunk({
      content,
      makePayload: makePage,
      maxBytes: EVE_NATIVE_RESULT_PAGE_BYTES,
      measurePayloadBytes: measure,
      offsetBytes: offset,
    }).payload;
  } catch (error) {
    if (
      hasPrefix &&
      error instanceof Error &&
      error.message.includes("cannot fit another UTF-8 character")
    ) {
      return undefined;
    }
    throw error;
  }
};

const isValidRepositoryOffset = (content: string, offsetBytes: number): boolean => {
  const bytes = Buffer.from(content, "utf-8");
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > bytes.byteLength) {
    return false;
  }
  const byte = bytes[offsetBytes] ?? 0;
  return offsetBytes === 0 || byte < 0x80 || byte > 0xbf;
};

/** Bound one serialized native result while retaining explicit access to every requested byte. */
export const readRepositoryInspectionPage = async (input: {
  sandbox: Pick<SandboxSession, "readTextFile">;
  baseline: Parameters<typeof readableAppBaselinePaths>[1];
  paths: string[];
  pathIndex?: number;
  offsetBytes?: number;
  metadata: NativeActionResultMetadata;
}): Promise<RepositoryInspectionPage> => {
  const { sandbox, paths, metadata } = input;
  const pathIndex = input.pathIndex ?? 0;
  const requestedOffsetBytes = input.offsetBytes ?? 0;
  const readable = await readableAppBaselinePaths(sandbox, input.baseline, paths);
  if (readable.length !== paths.length) {
    throw new Error(
      "A requested release archive is outside the selected app baseline and was not exposed as implementation input.",
    );
  }
  let page: RepositoryInspectionPage = { files: [], missingPaths: [] };
  const finish = (continuation?: RepositoryInspectionContinuation) => {
    const result: RepositoryInspectionPage = { files: page.files, missingPaths: page.missingPaths };
    if (continuation !== undefined) {
      result.continuation = continuation;
    }
    return fitOutputNativeFrame(result, metadata, EVE_NATIVE_RESULT_PAGE_BYTES);
  };
  for (let index = pathIndex; index < paths.length; index += 1) {
    const requestedPath = paths[index];
    if (requestedPath === undefined) {
      break;
    }
    const requestedOffset = index === pathIndex ? requestedOffsetBytes : 0;
    const relativePath = requestedPath.replace(/^\/workspace\/repository\//u, "");
    const content = await sandbox.readTextFile({ path: `/workspace/repository/${relativePath}` });
    const restartedFromOffsetBytes =
      content !== null && !isValidRepositoryOffset(content, requestedOffset)
        ? requestedOffset
        : undefined;
    const offset = restartedFromOffsetBytes === undefined ? requestedOffset : 0;
    const filePage = repositoryFilePage({
      content,
      index,
      metadata,
      offset,
      pathCount: paths.length,
      prefix: page,
      requestedPath,
      restartedFromOffsetBytes,
    });
    if (filePage === undefined) {
      return finish({ offsetBytes: offset, pathIndex: index });
    }
    page = filePage;
    if (page.continuation?.pathIndex === index) {
      return finish(page.continuation);
    }
  }
  return finish();
};

const inspectionNamespace = (input: {
  path: string;
  paths?: string[];
  mode?: "repository" | "workspace";
  directoryOffset?: number;
}) => {
  const files = input.paths?.length ? input.paths : undefined;
  const virtualChild = isWorkspaceDescendant(input.path);
  const explicitWorkspaceRoot =
    input.mode === "workspace" && input.path === developmentWorkspacePath;
  const directoryCursorAllowed =
    files === undefined && input.mode !== "repository" && (virtualChild || explicitWorkspaceRoot);
  const conflictingFiles = input.mode === "repository" && files !== undefined;
  const conflictingCursor = input.directoryOffset !== undefined && !directoryCursorAllowed;
  if (conflictingFiles || conflictingCursor) {
    throw new Error(
      "Directory continuation or file paths conflict with the selected inspection mode.",
    );
  }
  if (input.mode === "repository") {
    return { kind: "repository" as const, path: input.path };
  }
  const selectedPath =
    input.mode === "workspace" || virtualChild ? normalizedWorkspacePath(input.path) : input.path;
  if (files !== undefined) {
    return { kind: "files" as const, paths: files };
  }
  if (input.mode === "workspace" || isWorkspaceDescendant(selectedPath)) {
    return { kind: "entry" as const, path: selectedPath };
  }
  if (input.directoryOffset !== undefined) {
    throw new Error("Directory continuation requires the same workspace directory path.");
  }
  return { kind: "overview" as const, path: selectedPath };
};

export default defineTool({
  description:
    "Inspect the selected repository's original creation workspace. With paths, read text files relative to /workspace/repository, including public component exports, implementations, stories, and documentation. This does not inspect a separately edited draft PR candidate; read that candidate through edit_github_draft_pr_candidate with kind: read and validate it with validate_github_draft_pr_reconciliation. Resolve public imports from the inspected repository's tsconfig, workspace path maps, or package exports before requesting barrels. Read actual component props before composing a preview; do not guess APIs. Large results are paged. Repeat the same paths with the returned continuation.pathIndex and continuation.offsetBytes verbatim until continuation is absent; append each file chunk at its offsetBytes (omitted means byte 0). If a file chunk includes restartedFromOffsetBytes, replace that file's previously collected partial content with the returned chunk, then resume with the returned continuation verbatim. Without paths, path selects a repository root for its overview; virtual descendants such as /workspace/repository/packages inspect the selected Sandbox entry and page immediate directory entries. For directory pages repeat the same path with continuation.directoryOffset until absent. A file entry points to the exact path to read using paths. Use mode: repository to explicitly inspect an allowed local host root even if its physical path resembles the virtual namespace; mode: workspace never falls back to host inspection. Never writes or publishes.",
  async execute({ path, paths, pathIndex, offsetBytes, directoryOffset, mode }, ctx) {
    if (!canAutoSelectDevelopmentSource() && sourceWorkflowState.get().phase === "empty") {
      throw new Error(
        "Select the app source before repository inspection: source_status for a new app or resolve_github_source for an existing GitHub app.",
      );
    }
    const namespace = inspectionNamespace({ path, paths, mode, directoryOffset });
    if (namespace.kind === "repository") {
      if (!canAutoSelectDevelopmentSource()) {
        throw new Error(
          "Host repository inspection is available only in the configured local development source mode.",
        );
      }
      return inspectSupportedRepository(namespace.path);
    }
    if (namespace.kind === "files") {
      const sandbox = await getSourceBoundSandbox(ctx);
      return await readRepositoryInspectionPage({
        baseline: appBaselineState.get()?.selection,
        metadata: {
          callId: ctx.callId,
          toolName: "inspect_repository",
          turnId: ctx.session.turn.id,
        },
        offsetBytes,
        pathIndex,
        paths: namespace.paths,
        sandbox,
      });
    }
    if (namespace.kind === "entry") {
      const sandbox = await getSourceBoundSandbox(ctx);
      return await inspectWorkspacePath({
        path: namespace.path,
        directoryOffset,
        sandbox,
        baseline: appBaselineState.get()?.selection,
        metadata: {
          callId: ctx.callId,
          toolName: "inspect_repository",
          turnId: ctx.session.turn.id,
        },
        signal: ctx.abortSignal,
      });
    }
    const selectedPath = namespace.path;
    // Some models use the runtime-visible workspace path for their first
    // repository inspection. In local development that path does not exist on
    // the host running this tool yet. Treat it as the single configured source
    // only, materialize the writable sandbox overlay, and inspect the live
    // checkout. This keeps setup out of the conversation without granting any
    // other path special treatment.
    if (selectedPath === developmentWorkspacePath && canAutoSelectDevelopmentSource()) {
      const receipt = await developmentSourceReceipt("existing-repository");
      if (receipt === undefined) {
        throw new Error("The configured development source was unavailable.");
      }
      const workflow = appBuilderWorkflowState.get();
      if (workflow.phase === "empty") {
        assertUpstreamMutationAllowed(workflow, "development workspace setup");
        const workspace = await prepareDevelopmentSandboxWorkspace(
          receipt.sourcePath,
          await ctx.getSandbox(),
          ctx.callId,
          "planning",
        );
        sourceWorkflowState.update(() => ({
          phase: "reviewed",
          receipt,
          version: APP_BUILDER_SOURCE_VERSION,
        }));
        updateExactWorkflow({
          expected: workflow,
          operation: "development workspace setup",
          transition: () => ({
            artifacts: [],
            phase: "prepared",
            preparedByCallId: ctx.callId,
            sourceReceipt: receipt,
            version: APP_BUILDER_WORKFLOW_VERSION,
            workspace,
          }),
        });
      }
      return inspectSupportedRepository(receipt.sourcePath);
    }
    if (canAutoSelectDevelopmentSource()) {
      return inspectSupportedRepository(selectedPath);
    }

    const sandbox = await ctx.getSandbox();
    const availablePaths: string[] = [];
    const missingPaths: string[] = [];
    const readOverviewPath = async (index: number): Promise<void> => {
      const overviewPath = sandboxOverviewPaths[index];
      if (overviewPath === undefined) {
        return;
      }
      const content = await sandbox.readTextFile({
        path: `repository/${overviewPath}`,
      });
      if (content === null) {
        missingPaths.push(overviewPath);
      } else {
        availablePaths.push(overviewPath);
      }
      await readOverviewPath(index + 1);
    };
    await readOverviewPath(0);
    return {
      availablePaths,
      workspacePath: developmentWorkspacePath,
      ...(missingPaths.length === 0 ? {} : { missingPaths }),
    };
  },
  inputSchema: z.object({
    mode: z
      .enum(["repository", "workspace"])
      .optional()
      .describe(
        "Explicit namespace when needed: repository inspects an allowed local host repository root; workspace inspects the selected Sandbox entry. Omitted mode preserves the root overview and routes virtual descendants to the Sandbox.",
      ),
    path: z
      .string()
      .min(1)
      .default(developmentWorkspacePath)
      .describe(
        "Repository root for overview, or an absolute /workspace/repository descendant for selected Sandbox entry inspection. Explicit local host repository roots retain their existing meaning.",
      ),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Text files relative to the selected repository, or absolute /workspace/repository file paths. Read package.json exports to resolve actual file names.",
      ),
    directoryOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Repeat the same workspace directory path with the returned continuation.directoryOffset; do not combine with paths.",
      ),
    pathIndex: z.number().int().nonnegative().optional(),
    offsetBytes: z.number().int().nonnegative().optional(),
  }),
});
