import { defineDynamic, defineTool } from "eve/tools";
import { createHash } from "node:crypto";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { readableAppBaselinePaths } from "@/lib/repository/app-baseline";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import { safeSourcePath } from "@/lib/repository/source-path";
import type { SandboxSession } from "eve/sandbox";
import sourceStatus from "./source_status";
import prepareWorkspace from "./prepare_workspace";
import { canAutoSelectDevelopmentSource } from "@/lib/repository/development-source";
import {
  EVE_MAX_PAYLOAD_BYTES,
  largestUtf8PayloadChunk,
  serializedPayloadBytes,
} from "@/lib/eve/payload-envelope";

// The source checkout is writable. An initial clone manifest cannot describe
// files added or removed during an existing-app session.
type AppSourceFileRunner = Pick<SandboxSession, "run">;
interface SourceInspectionFile {
  content: string;
  digest: string;
  offsetBytes: number;
  path: string;
}

interface SourceInspectionContinuation {
  digest: string;
  offsetBytes: number;
  path: string;
}

interface SourceInspectionOutput {
  appId: string;
  availablePaths: string[];
  continuation?: SourceInspectionContinuation;
  files: SourceInspectionFile[];
  missingPaths?: string[];
  nextPathIndex?: number;
}

const sourceInspectionEvent = function sourceInspectionEvent(output: SourceInspectionOutput) {
  return {
    data: {
      result: { kind: "tool-result", output, toolName: "inspect_existing_app" },
    },
    type: "action.result",
  };
};

const listSourcePathPage = function listSourcePathPage(
  appId: string,
  availablePaths: string[],
  pathIndex: number,
) {
  const pathPage: string[] = [];
  let nextPathIndex = pathIndex;
  let canAppend = true;
  while (nextPathIndex < availablePaths.length && canAppend) {
    const candidate = availablePaths[nextPathIndex];
    if (candidate === undefined) {
      canAppend = false;
    } else {
      const next = [...pathPage, candidate];
      const output: SourceInspectionOutput = {
        appId,
        availablePaths: next,
        files: [],
        missingPaths: [],
      };
      if (serializedPayloadBytes(sourceInspectionEvent(output)) > EVE_MAX_PAYLOAD_BYTES) {
        canAppend = false;
      } else {
        pathPage.push(candidate);
        nextPathIndex += 1;
      }
    }
  }
  return { nextPathIndex, pathPage };
};

const readSourceFilePage = async function readSourceFilePage(
  sandbox: Pick<SandboxSession, "readTextFile">,
  input: {
    appId: string;
    availablePaths: string[];
    expectedDigest?: string;
    files: SourceInspectionFile[];
    missingPaths: string[];
    offsetBytes: number;
    path: string;
  },
): Promise<{ continuation?: SourceInspectionContinuation; file?: SourceInspectionFile } | null> {
  const { appId, availablePaths, expectedDigest, files, missingPaths, offsetBytes, path } = input;
  const content = await sandbox.readTextFile({ path: `repository/${path}` });
  if (content === null) {
    return null;
  }
  const digest = createHash("sha256").update(content, "utf-8").digest("hex");
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new Error(`Source file ${path} changed during review. Read it again from byte offset 0.`);
  }
  if (content.length === 0) {
    return { file: { content, digest, offsetBytes: 0, path } };
  }

  const payloadBase = {
    appId,
    availablePaths,
    files,
    missingPaths,
  };
  let chunk: ReturnType<typeof largestUtf8PayloadChunk<ReturnType<typeof sourceInspectionEvent>>>;
  try {
    chunk = largestUtf8PayloadChunk({
      content,
      makePayload: (chunkContent, nextOffsetBytes) =>
        sourceInspectionEvent({
          ...payloadBase,
          files: [...files, { content: chunkContent, digest, offsetBytes, path }],
          ...(nextOffsetBytes < Buffer.byteLength(content, "utf-8")
            ? { continuation: { digest, offsetBytes: nextOffsetBytes, path } }
            : {}),
        }),
      offsetBytes,
    });
  } catch (error) {
    if (
      files.length > 0 &&
      error instanceof Error &&
      error.message.includes("cannot fit another UTF-8 character")
    ) {
      return { continuation: { digest, offsetBytes, path } };
    }
    throw error;
  }
  return {
    file: { content: chunk.content, digest, offsetBytes, path },
    ...(chunk.nextOffsetBytes < Buffer.byteLength(content, "utf-8")
      ? { continuation: { digest, offsetBytes: chunk.nextOffsetBytes, path } }
      : {}),
  };
};

type AppBuilderState = ReturnType<typeof appBuilderWorkflowState.get>;
type AppSourceReader = Pick<SandboxSession, "readTextFile" | "run">;

const sanitizeSourceCommandError = function sanitizeSourceCommandError(value: string): string {
  return value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .trim();
};

export const listCurrentAppSourcePaths = async function listCurrentAppSourcePaths(
  sandbox: AppSourceFileRunner,
  appId: string,
) {
  const prefix = `apps/${appId}/`;
  const escaped = prefix.replaceAll("'", "'\"'\"'");
  const quoted = `'${escaped}'`;
  const listed = await sandbox.run({
    command: `git -C /workspace/repository ls-files -z --cached --others --exclude-standard -- ${quoted}`,
    workingDirectory: "/workspace",
  });
  if (listed.exitCode !== 0) {
    const detail = sanitizeSourceCommandError(listed.stderr) || `git exited ${listed.exitCode}`;
    throw new Error(`Could not list current ${appId} source files: ${detail}`);
  }

  return listed.stdout
    .split("\0")
    .filter((path) => path.startsWith(prefix) && safeSourcePath(path))
    .toSorted();
};

const listAvailableSourcePaths = async function listAvailableSourcePaths(
  state: AppBuilderState,
  sandbox: AppSourceReader,
  appId: string,
  prefix: string,
): Promise<string[]> {
  if (state.phase !== "empty") {
    return await listCurrentAppSourcePaths(sandbox, appId);
  }
  const manifestSource = await sandbox.readTextFile({ path: ".app-builder/source-files.json" });
  let manifest: unknown = [];
  try {
    manifest = manifestSource === null ? [] : JSON.parse(manifestSource);
  } catch {
    manifest = [];
  }
  const entries = Array.isArray(manifest) ? manifest : [];
  const allowedPaths = entries.flatMap((candidate): string[] => {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "path" in candidate &&
      typeof candidate.path === "string"
    ) {
      return [candidate.path];
    }
    return [];
  });
  return [...new Set(allowedPaths)]
    .filter((path) => path.startsWith(prefix))
    .filter(safeSourcePath)
    .toSorted();
};

const normalizeRequestedSourcePaths = function normalizeRequestedSourcePaths(
  paths: string[],
  contentPath: string | undefined,
  prefix: string,
) {
  if (contentPath !== undefined) {
    return [contentPath.startsWith(prefix) ? contentPath : `${prefix}${contentPath}`];
  }
  return paths.flatMap((path) =>
    safeSourcePath(path) ? [path.startsWith(prefix) ? path : `${prefix}${path}`] : [],
  );
};

const buildSourceInspectionOutput = async function buildSourceInspectionOutput(input: {
  appId: string;
  availablePaths: string[];
  contentPath?: string;
  expectedDigest?: string;
  offsetBytes?: number;
  pathIndex: number;
  paths: string[];
  sandbox: Pick<SandboxSession, "readTextFile">;
}) {
  const {
    appId,
    availablePaths,
    contentPath,
    expectedDigest,
    offsetBytes,
    pathIndex,
    paths,
    sandbox,
  } = input;
  const { nextPathIndex, pathPage } = listSourcePathPage(appId, availablePaths, pathIndex);
  const files: SourceInspectionFile[] = [];
  const missingPaths: string[] = [];
  let continuation: SourceInspectionContinuation | undefined;
  for (const [index, path] of paths.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Keep source chunks ordered and stop at the first continuation.
    const readResult = await readSourceFilePage(sandbox, {
      appId,
      availablePaths: pathPage,
      expectedDigest: contentPath === undefined ? undefined : expectedDigest,
      files,
      missingPaths,
      offsetBytes: contentPath === undefined ? 0 : (offsetBytes ?? 0),
      path,
    });
    if (readResult === null) {
      missingPaths.push(path);
    } else {
      const { continuation: nextContinuation, file } = readResult;
      if (file !== undefined) {
        files.push(file);
      }
      if (nextContinuation !== undefined) {
        continuation = nextContinuation;
      }
    }
    if (continuation !== undefined || index + 1 >= paths.length) {
      break;
    }
  }
  const response: SourceInspectionOutput = {
    appId,
    availablePaths: pathPage,
    ...(nextPathIndex < availablePaths.length ? { nextPathIndex } : {}),
    files,
    ...(missingPaths.length === 0 ? {} : { missingPaths }),
    ...(continuation === undefined ? {} : { continuation }),
  };
  if (serializedPayloadBytes(sourceInspectionEvent(response)) > EVE_MAX_PAYLOAD_BYTES) {
    throw new Error(
      "The requested source inspection metadata exceeds Eve's provider transport envelope. Request fewer paths in one call, then continue with the returned file digest and byte offset.",
    );
  }
  return response;
};

export default defineDynamic({
  events: {
    "step.started": () =>
      defineTool({
        description:
          "Read regular text files from one existing application after selecting its source. First call with no paths to list app-owned files; continue path listings with nextPathIndex. Request a small relevant set of paths for content. Large files return a digest and UTF-8 byte offset; continue with contentPath, offsetBytes, and expectedDigest until complete. This is read-only and never writes or publishes.",
        async execute({ appId, paths, pathIndex, contentPath, offsetBytes, expectedDigest }, ctx) {
          let state = appBuilderWorkflowState.get();
          // Local development can use its configured checkout. Hosted
          // inspection must wait for the source selected for this run.
          if (state.phase === "empty") {
            if (!canAutoSelectDevelopmentSource()) {
              throw new Error(
                "Select the app source before inspection: resolve_github_source for an existing GitHub app.",
              );
            }
            try {
              await sourceStatus.execute({}, ctx);
              const source = sourceWorkflowState.get();
              if (source.phase !== "empty") {
                await prepareWorkspace.execute({}, ctx);
              }
            } catch {
              // The session sandbox remains the authority for a best-effort
              // read of newly generated files, even before its workflow state
              // has caught up.
            }
            state = appBuilderWorkflowState.get();
          }
          const prefix = `apps/${appId}/`;
          if (!safeSourcePath(appId) || appId.includes("/")) {
            throw new Error("The requested application cannot be read safely.");
          }
          if (contentPath !== undefined && !safeSourcePath(contentPath)) {
            throw new Error("The requested source path cannot be read safely.");
          }
          const sandbox = await getSourceBoundSandbox(ctx);
          // The signed-in session supplies this sandbox. Read its current
          // files; source receipts are not prerequisites for inspection.
          const selection = appBaselineState.get()?.selection;
          const availablePaths = await readableAppBaselinePaths(
            sandbox,
            selection,
            await listAvailableSourcePaths(state, sandbox, appId, prefix),
          );
          const selectedPaths = normalizeRequestedSourcePaths(paths, contentPath, prefix);
          const readable = await readableAppBaselinePaths(sandbox, selection, selectedPaths);
          if (readable.length !== selectedPaths.length) {
            throw new Error(
              "A requested release archive is outside the selected app baseline and was not exposed as implementation input.",
            );
          }
          return await buildSourceInspectionOutput({
            appId,
            availablePaths,
            contentPath,
            expectedDigest,
            offsetBytes,
            pathIndex,
            paths: selectedPaths,
            sandbox,
          });
        },
        inputSchema: z
          .strictObject({
            appId: z.string().min(1),
            contentPath: z.string().min(1).optional(),
            expectedDigest: z
              .string()
              .regex(/^[0-9a-f]{64}$/u)
              .optional(),
            offsetBytes: z.number().int().nonnegative().optional(),
            pathIndex: z.number().int().nonnegative().default(0),
            paths: z.array(z.string().min(1)).default([]),
          })
          .superRefine((input, context) => {
            if (
              (input.offsetBytes !== undefined || input.expectedDigest !== undefined) &&
              input.contentPath === undefined
            ) {
              context.addIssue({
                code: "custom",
                message: "Chunked source reads require contentPath.",
                path: ["contentPath"],
              });
            }
            if (
              input.offsetBytes !== undefined &&
              input.offsetBytes > 0 &&
              input.expectedDigest === undefined
            ) {
              context.addIssue({
                code: "custom",
                message: "Resuming a source read requires the prior full-file digest.",
                path: ["expectedDigest"],
              });
            }
          }),
      }),
  },
});
