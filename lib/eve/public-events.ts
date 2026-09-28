import { createHash } from "node:crypto";

import {
  publicPrototypeSchema,
  publicPrototypeReferenceSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
} from "../mcp/contracts";
import type {
  EveSessionStatus,
  PublicEveEvent,
  PublicInputRequest,
  PublicPrototype,
  PublicPrototypeReference,
  PublicUiPreview,
  PublicWorkingPreview,
} from "../mcp/contracts";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { publicApprovalDescription } from "../agent/approval-receipt";
import {
  githubRepositoryAccessSchema,
  githubRepositoryAccessViewModel,
} from "../integrations/store-in-view-model";

export interface InternalEveEvent {
  type: string;
  index: number;
  turnId?: string;
  text?: string;
  label?: string;
  state?: string;
  request?: PublicInputRequest;
  code?: string;
  message?: string;
  status?: EveSessionStatus;
  requestIds?: string[];
}

const progressStates = new Set(["started", "completed", "failed"]);
const visibleOperations = new Map([
  ["apply_app_creation", "Building the app in its private workspace"],
  ["compile-app-schema-release", "Compiling the app schema release"],
  ["prepare-app-local-preview", "Preparing the app's local preview dependencies"],
  ["run-app-browser-tests", "Running the app's browser tests"],
  ["start_app_preview", "Starting the app preview"],
  ["validate_app_creation", "Validating the app changes"],
  ["validate-app-creation", "Validating the app changes"],
]);
const visibleOperationLabels = new Set(visibleOperations.values());

export const pendingBuilderOperation = (events: readonly PublicEveEvent[]): string => {
  const pending = new Set<string>();
  for (const event of events) {
    if (event.type !== "progress" || !visibleOperationLabels.has(event.label)) {
      continue;
    }
    if (event.state === "started") {
      pending.add(event.label);
    } else {
      pending.delete(event.label);
    }
  }
  return [...pending].at(-1) ?? "the current Builder step";
};
const silentInternalApprovalTools = new Set([
  "accept_app_spec",
  "validate-app-creation",
  "accept_change_set",
]);
const unavailableConfirmationMessage =
  "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.";
const publicFailureLimit = 700;
const publicErrorCode = (value: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value) ? value : "unknown_error";
const publicFailureDetail = (value: string) =>
  value
    .replaceAll(/\s*\r?\n\s*/gu, " | ")
    .replaceAll(/\p{Cc}/gu, " ")
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
    .trim()
    .slice(0, publicFailureLimit);

const publicBuilderFailure = (failure: { code: string; message: string }, operation?: string) => {
  const name = operation === undefined ? "the current Builder operation" : `\`${operation}\``;
  const size =
    /Chunk size (?<actual>\d+) exceeds maximum allowed size of (?<maximum>\d+) bytes/u.exec(
      failure.message,
    );
  if (size?.groups !== undefined) {
    return {
      code: "result_too_large",
      message: `Builder could not complete ${name}: the serialized Eve event was ${size.groups.actual} bytes, above Eve's ${size.groups.maximum}-byte event envelope. For prototype or UI-preview content, retry with smaller UTF-8-safe chunks using the chunked read/write path, then resume this saved session.`,
    };
  }
  const code = publicErrorCode(failure.code);
  const detail = publicFailureDetail(failure.message);
  if (detail.length === 0) {
    return {
      code,
      message: `Builder could not complete ${name} (${code}). The provider returned no diagnostic cause, so Builder cannot identify a file or setting to change. Retry this saved session once; if it repeats, report this operation, error code, and session ID as a missing-provider-diagnostic defect.`,
    };
  }
  let cause = `Cause: ${detail}`;
  if (!/[.!?]$/u.test(detail)) {
    cause += ".";
  }
  return {
    code,
    message: `Builder could not complete ${name} (${code}). ${cause} Your progress is saved; correct the cause and resume this session.`,
  };
};
// Browser projection accepts only HTML; Markdown AppSpec/decision artifacts never become previews.
const prototypePathPattern = /^prototype\/(?<appId>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/index\.html$/u;
const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");
const prototypeRequestSchema = z
  .object({
    baseRevision: lowercaseSha256Schema.optional(),
    chunkIndex: z.number().int().nonnegative().optional(),
    content: z.string().min(1),
    expectedDigest: lowercaseSha256Schema.optional(),
    finalChunk: z.boolean().optional(),
    mediaType: z.literal("text/html"),
    path: z.string().regex(prototypePathPattern),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.chunkIndex === undefined && input.expectedDigest !== undefined) {
      context.addIssue({ code: "custom", message: "Missing chunk index.", path: ["chunkIndex"] });
    }
    if (input.chunkIndex !== undefined && input.expectedDigest === undefined) {
      context.addIssue({
        code: "custom",
        message: "Missing full digest.",
        path: ["expectedDigest"],
      });
    }
    if (input.chunkIndex !== undefined && input.finalChunk === undefined) {
      context.addIssue({
        code: "custom",
        message: "Missing final chunk marker.",
        path: ["finalChunk"],
      });
    }
  });
const prototypeResultSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    complete: z.boolean().optional(),
    digest: lowercaseSha256Schema,
    invalidated: z.boolean().optional(),
    mediaType: z.literal("text/html"),
    nextChunkIndex: z.number().int().nonnegative().optional(),
    path: z.string().regex(prototypePathPattern),
    recordedByCallId: z.string().min(1),
    reused: z.boolean(),
    revision: lowercaseSha256Schema,
    sessionId: z.string().min(1),
    size: z.number().int().min(1),
  })
  .strict();

const prototypeReferenceResultSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    chunkCount: z.number().int().positive(),
    complete: z.literal(true),
    contentBytes: z.number().int().positive(),
    digest: lowercaseSha256Schema,
    mediaType: z.literal("text/html"),
    path: z.string().regex(prototypePathPattern),
    recordedByCallId: z.string().min(1),
    revision: lowercaseSha256Schema,
    sessionId: z.string().min(1),
    version: z.literal(2),
  })
  .passthrough();

/** Projects v2 manifests only from a matching completed tool receipt. */
export const createInstalledPrototypeReferenceReducer = (input: { sessionId: string }) => {
  const requested = new Map<string, z.infer<typeof prototypeRequestSchema>>();
  const requestedUiPreview = new Map<string, string>();
  let latest: PublicPrototypeReference | undefined;
  return {
    accept(candidate: unknown) {
      const event = z
        .object({ data: z.unknown(), type: z.string() })
        .passthrough()
        .safeParse(candidate);
      if (!event.success) {
        return;
      }
      if (event.data.type === "actions.requested") {
        const actions = z
          .object({ actions: z.array(z.unknown()) })
          .passthrough()
          .safeParse(event.data.data);
        if (!actions.success) {
          return;
        }
        for (const candidateAction of actions.data.actions) {
          const action = z
            .object({
              callId: z.string(),
              input: z.unknown(),
              kind: z.string(),
              toolName: z.string(),
            })
            .passthrough()
            .safeParse(candidateAction);
          if (!action.success || action.data.kind !== "tool-call") {
            continue;
          }
          if (action.data.toolName !== "record_prototype_artifact") {
            requested.delete(action.data.callId);
            if (action.data.toolName === "record_ui_preview") {
              const preview = z
                .object({ appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u) })
                .passthrough()
                .safeParse(action.data.input);
              if (preview.success) {
                requestedUiPreview.set(action.data.callId, preview.data.appId);
              }
            } else {
              requestedUiPreview.delete(action.data.callId);
            }
            continue;
          }
          requestedUiPreview.delete(action.data.callId);
          const parsed = prototypeRequestSchema.safeParse(action.data.input);
          if (parsed.success) {
            requested.set(action.data.callId, parsed.data);
          }
        }
        return;
      }
      if (event.data.type !== "action.result") {
        return;
      }
      const resultEvent = z
        .object({
          result: z
            .object({
              callId: z.string(),
              isError: z.boolean().optional(),
              kind: z.literal("tool-result"),
              output: z.unknown(),
              toolName: z.enum(["record_prototype_artifact", "record_ui_preview"]),
            })
            .passthrough(),
          status: z.literal("completed"),
        })
        .passthrough()
        .safeParse(event.data.data);
      if (!resultEvent.success) {
        return;
      }
      const receipt = resultEvent.data.result;
      if (receipt.toolName === "record_ui_preview") {
        const appId = requestedUiPreview.get(receipt.callId);
        requestedUiPreview.delete(receipt.callId);
        if (appId === undefined || receipt.isError === true) {
          return;
        }
        const output = z
          .object({
            appId: z.string(),
            artifactDigest: lowercaseSha256Schema,
            artifactRevision: lowercaseSha256Schema,
            chunkCount: z.number().int().positive(),
            complete: z.literal(true),
            contentBytes: z.number().int().positive(),
            digest: lowercaseSha256Schema,
            mediaType: z.literal("text/html"),
            path: z.string().regex(prototypePathPattern),
            recordedByCallId: z.string(),
            sessionId: z.string(),
            version: z.literal(2),
          })
          .passthrough()
          .safeParse(receipt.output);
        if (!output.success) {
          return;
        }
        const value = output.data;
        if (
          value.appId !== appId ||
          value.path !== `prototype/${appId}/index.html` ||
          value.sessionId !== input.sessionId ||
          value.recordedByCallId !== receipt.callId ||
          value.digest !== value.artifactDigest ||
          value.artifactRevision !==
            sha256(
              JSON.stringify({
                digest: value.digest,
                mediaType: value.mediaType,
                path: value.path,
              }),
            )
        ) {
          return;
        }
        const projected = publicPrototypeReferenceSchema.safeParse({
          appId,
          chunkCount: value.chunkCount,
          contentBytes: value.contentBytes,
          digest: value.digest,
          mediaType: value.mediaType,
          path: value.path,
          recordedByCallId: value.recordedByCallId,
          revision: value.artifactRevision,
          sessionId: value.sessionId,
          version: 2,
        });
        if (projected.success) {
          latest = projected.data;
        }
        return;
      }
      const request = requested.get(receipt.callId);
      requested.delete(receipt.callId);
      if (request === undefined || receipt.isError === true) {
        return;
      }
      const output = prototypeReferenceResultSchema.safeParse(receipt.output);
      if (!output.success) {
        return;
      }
      const value = output.data;
      const revision = sha256(
        JSON.stringify({ digest: value.digest, mediaType: value.mediaType, path: value.path }),
      );
      if (
        value.sessionId !== input.sessionId ||
        value.recordedByCallId !== receipt.callId ||
        value.appId !== prototypePathPattern.exec(request.path)?.groups?.appId ||
        value.path !== request.path ||
        value.mediaType !== request.mediaType ||
        value.revision !== revision ||
        (request.expectedDigest !== undefined && value.digest !== request.expectedDigest) ||
        (request.chunkIndex !== undefined &&
          (request.finalChunk !== true || value.chunkCount !== request.chunkIndex + 1)) ||
        (request.chunkIndex === undefined &&
          (value.digest !== sha256(request.content) ||
            value.contentBytes !== Buffer.byteLength(request.content, "utf-8")))
      ) {
        return;
      }
      const projected = publicPrototypeReferenceSchema.safeParse({
        appId: value.appId,
        chunkCount: value.chunkCount,
        contentBytes: value.contentBytes,
        digest: value.digest,
        mediaType: value.mediaType,
        path: value.path,
        recordedByCallId: value.recordedByCallId,
        revision: value.revision,
        sessionId: value.sessionId,
        version: 2,
      });
      if (projected.success) {
        latest = projected.data;
      }
    },
    snapshot: () => latest,
  };
};
const uiPreviewResultSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    artifactDigest: lowercaseSha256Schema.optional(),
    artifactRevision: lowercaseSha256Schema.optional(),
    complete: z.boolean().optional(),
    content: z.string().min(1).optional(),
    digest: lowercaseSha256Schema,
    fidelity: z.literal("arrusted-component-catalog"),
    functionality: z.literal("fixtures-only"),
    requiresChunkedRead: z.boolean().optional(),
    revision: lowercaseSha256Schema,
    routes: z.array(z.string().startsWith("/")).min(1),
    totalBytes: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Recovers only a successfully recorded HTML prototype from Eve's durable
 * action stream. Raw tool input is never projected without its matching,
 * completed receipt.
 */
export interface InstalledPrototypeProjector {
  observe: (event: MessageStreamEvent) => void;
  current: () => PublicPrototype | undefined;
}

export const createInstalledPrototypeProjector = (): InstalledPrototypeProjector => {
  const requested = new Map<string, z.infer<typeof prototypeRequestSchema>>();
  const artifactReadRequests = new Map<
    string,
    { path: string; digest: string; revision?: string; offsetBytes?: number }
  >();
  const readChunks = new Map<
    string,
    {
      chunks: string[];
      nextOffsetBytes: number;
      totalBytes: number;
      mediaType: "text/html";
      path: string;
      digest: string;
      revision: string;
    }
  >();
  let expectedChunkedPreview: { path: string; digest: string; revision: string } | undefined;
  const transfers = new Map<
    string,
    {
      expectedDigest: string;
      chunks: string[];
      nextChunkIndex: number;
      revision: string;
      lastChunkIndex: number;
      lastChunkDigest: string;
      lastCallId: string;
      receivedBytes: number;
      rollingDigest: string;
    }
  >();
  let latest: PublicPrototype | undefined;

  const observe = (event: MessageStreamEvent): void => {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") {
          continue;
        }
        if (action.toolName === "record_prototype_artifact") {
          const parsed = prototypeRequestSchema.safeParse(action.input);
          if (parsed.success) {
            requested.set(action.callId, parsed.data);
          } else {
            requested.delete(action.callId);
          }
        } else {
          requested.delete(action.callId);
        }
        if (action.toolName === "get_prototype_artifact") {
          const read = z
            .object({
              digest: lowercaseSha256Schema,
              offsetBytes: z.number().int().nonnegative().optional(),
              path: z.string().regex(prototypePathPattern),
              revision: lowercaseSha256Schema.optional(),
            })
            .safeParse(action.input);
          if (read.success) {
            artifactReadRequests.set(action.callId, read.data);
          } else {
            artifactReadRequests.delete(action.callId);
          }
        } else {
          artifactReadRequests.delete(action.callId);
        }
      }
      return;
    }

    if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.isError === true
    ) {
      return;
    }

    if (event.data.result.toolName === "record_ui_preview") {
      const preview = uiPreviewResultSchema.safeParse(event.data.result.output);
      if (!preview.success || preview.data.complete === false) {
        return;
      }
      if (preview.data.content !== undefined) {
        if (sha256(preview.data.content) !== preview.data.digest) {
          return;
        }
        latest = publicPrototypeSchema.parse({
          content: preview.data.content,
          digest: preview.data.digest,
          mediaType: "text/html",
          path: `prototype/${preview.data.appId}/index.html`,
          revision: preview.data.artifactRevision ?? preview.data.digest,
        });
      } else if (
        preview.data.requiresChunkedRead === true &&
        preview.data.artifactDigest !== undefined &&
        preview.data.artifactRevision !== undefined
      ) {
        expectedChunkedPreview = {
          digest: preview.data.artifactDigest,
          path: `prototype/${preview.data.appId}/index.html`,
          revision: preview.data.artifactRevision,
        };
      }
      return;
    }
    if (event.data.result.toolName === "get_prototype_artifact") {
      const { callId } = event.data.result;
      const input = artifactReadRequests.get(callId);
      const output = z
        .object({
          byteOffset: z.number().int().nonnegative().optional(),
          chunkDigest: lowercaseSha256Schema.optional(),
          complete: z.boolean().optional(),
          content: z.string().min(1),
          digest: lowercaseSha256Schema,
          mediaType: z.literal("text/html"),
          nextOffsetBytes: z.number().int().nonnegative().optional(),
          path: z.string().regex(prototypePathPattern),
          revision: lowercaseSha256Schema,
          totalBytes: z.number().int().positive().optional(),
        })
        .safeParse(event.data.result.output);
      if (
        input === undefined ||
        !output.success ||
        input.path !== output.data.path ||
        input.digest !== output.data.digest ||
        (input.revision !== undefined && input.revision !== output.data.revision)
      ) {
        return;
      }
      if (output.data.byteOffset === undefined) {
        if (sha256(output.data.content) !== output.data.digest) {
          return;
        }
        latest = publicPrototypeSchema.parse({ ...output.data, mediaType: "text/html" });
        return;
      }
      const { byteOffset, nextOffsetBytes, totalBytes, chunkDigest } = output.data;
      if (
        nextOffsetBytes === undefined ||
        totalBytes === undefined ||
        chunkDigest === undefined ||
        input.offsetBytes !== byteOffset ||
        sha256(output.data.content) !== chunkDigest ||
        Buffer.byteLength(output.data.content, "utf-8") !== nextOffsetBytes - byteOffset
      ) {
        readChunks.delete(output.data.path);
        return;
      }
      const prior = readChunks.get(output.data.path);
      if (byteOffset === 0) {
        if (input.revision === undefined) {
          readChunks.delete(output.data.path);
          return;
        }
        readChunks.set(output.data.path, {
          chunks: [output.data.content],
          digest: output.data.digest,
          mediaType: "text/html",
          nextOffsetBytes,
          path: output.data.path,
          revision: output.data.revision,
          totalBytes,
        });
      } else if (
        prior !== undefined &&
        prior.nextOffsetBytes === byteOffset &&
        prior.totalBytes === totalBytes &&
        prior.digest === output.data.digest &&
        prior.revision === output.data.revision &&
        input.revision === prior.revision
      ) {
        readChunks.set(output.data.path, {
          ...prior,
          chunks: [...prior.chunks, output.data.content],
          nextOffsetBytes,
        });
      } else {
        readChunks.delete(output.data.path);
        return;
      }
      const assembled = readChunks.get(output.data.path);
      if (output.data.complete === true && assembled?.nextOffsetBytes === totalBytes) {
        const content = assembled.chunks.join("");
        if (
          sha256(content) === assembled.digest &&
          (expectedChunkedPreview === undefined ||
            (expectedChunkedPreview.path === assembled.path &&
              expectedChunkedPreview.digest === assembled.digest &&
              expectedChunkedPreview.revision === assembled.revision))
        ) {
          latest = publicPrototypeSchema.parse({
            content,
            digest: assembled.digest,
            mediaType: "text/html",
            path: assembled.path,
            revision: assembled.revision,
          });
        }
        readChunks.delete(output.data.path);
      }
      return;
    }
    if (event.data.result.toolName !== "record_prototype_artifact") {
      return;
    }

    const { callId } = event.data.result;
    const input = requested.get(callId);
    const output = prototypeResultSchema.safeParse(event.data.result.output);
    if (input === undefined || !output.success) {
      return;
    }

    const appId = prototypePathPattern.exec(input.path)?.groups?.appId;
    if (input.chunkIndex !== undefined && input.expectedDigest !== undefined) {
      const prior = transfers.get(input.path);
      const chunkDigest = sha256(input.content);
      if (input.chunkIndex === 0) {
        if (
          input.expectedDigest === chunkDigest &&
          output.data.complete === true &&
          output.data.digest === chunkDigest &&
          output.data.appId === appId &&
          output.data.path === input.path &&
          output.data.mediaType === input.mediaType &&
          output.data.size === Buffer.byteLength(input.content, "utf-8") &&
          output.data.recordedByCallId === callId
        ) {
          const revision = sha256(
            JSON.stringify({ digest: chunkDigest, mediaType: input.mediaType, path: input.path }),
          );
          if (output.data.revision === revision) {
            transfers.delete(input.path);
            latest = publicPrototypeSchema.parse({
              content: input.content,
              digest: chunkDigest,
              mediaType: input.mediaType,
              path: input.path,
              revision,
            });
          }
          return;
        }
        const rollingDigest = sha256(chunkDigest);
        const receivedBytes = Buffer.byteLength(input.content, "utf-8");
        if (
          output.data.digest !== rollingDigest ||
          output.data.nextChunkIndex !== 1 ||
          output.data.complete !== false
        ) {
          transfers.delete(input.path);
          return;
        }
        const transfer = {
          chunks: [input.content],
          expectedDigest: input.expectedDigest,
          lastCallId: callId,
          lastChunkDigest: chunkDigest,
          lastChunkIndex: 0,
          nextChunkIndex: 1,
          receivedBytes,
          rollingDigest,
        };
        const revision = sha256(
          JSON.stringify({
            digest: rollingDigest,
            mediaType: input.mediaType,
            path: input.path,
            transfer,
          }),
        );
        if (
          output.data.revision !== revision ||
          output.data.appId !== appId ||
          output.data.path !== input.path ||
          output.data.mediaType !== input.mediaType ||
          output.data.size !== receivedBytes ||
          output.data.recordedByCallId !== callId
        ) {
          transfers.delete(input.path);
          return;
        }
        transfers.set(input.path, {
          chunks: [input.content],
          expectedDigest: input.expectedDigest,
          lastCallId: callId,
          lastChunkDigest: chunkDigest,
          lastChunkIndex: 0,
          nextChunkIndex: 1,
          receivedBytes,
          revision,
          rollingDigest,
        });
        return;
      }
      if (prior === undefined || prior.expectedDigest !== input.expectedDigest) {
        transfers.delete(input.path);
        return;
      }
      if (
        input.chunkIndex === prior.lastChunkIndex &&
        callId === prior.lastCallId &&
        chunkDigest === prior.lastChunkDigest
      ) {
        return;
      }
      if (
        input.chunkIndex !== prior.nextChunkIndex ||
        input.baseRevision !== prior.revision ||
        output.data.nextChunkIndex !== input.chunkIndex + 1
      ) {
        transfers.delete(input.path);
        return;
      }
      const chunks = [...prior.chunks, input.content];
      const receivedBytes = prior.receivedBytes + Buffer.byteLength(input.content, "utf-8");
      const rollingDigest = sha256(`${prior.rollingDigest}${chunkDigest}`);
      if (
        output.data.appId !== appId ||
        output.data.path !== input.path ||
        output.data.mediaType !== input.mediaType ||
        output.data.digest !== (input.finalChunk === true ? input.expectedDigest : rollingDigest) ||
        output.data.size !== receivedBytes ||
        output.data.recordedByCallId !== callId
      ) {
        transfers.delete(input.path);
        return;
      }
      const complete = input.finalChunk === true;
      if (output.data.complete !== complete) {
        transfers.delete(input.path);
        return;
      }
      const assembled = complete ? chunks.join("") : null;
      const digest = assembled === null ? rollingDigest : sha256(assembled);
      if (complete && digest !== input.expectedDigest) {
        transfers.delete(input.path);
        return;
      }
      const revision = complete
        ? sha256(JSON.stringify({ digest, mediaType: input.mediaType, path: input.path }))
        : sha256(
            JSON.stringify({
              digest: rollingDigest,
              mediaType: input.mediaType,
              path: input.path,
              transfer: {
                chunks,
                expectedDigest: input.expectedDigest,
                lastCallId: callId,
                lastChunkDigest: chunkDigest,
                lastChunkIndex: input.chunkIndex,
                nextChunkIndex: input.chunkIndex + 1,
                receivedBytes,
                rollingDigest,
              },
            }),
          );
      if (output.data.revision !== revision) {
        transfers.delete(input.path);
        return;
      }
      if (assembled === null) {
        transfers.set(input.path, {
          chunks,
          expectedDigest: input.expectedDigest,
          lastCallId: callId,
          lastChunkDigest: chunkDigest,
          lastChunkIndex: input.chunkIndex,
          nextChunkIndex: input.chunkIndex + 1,
          receivedBytes,
          revision,
          rollingDigest,
        });
      } else {
        transfers.delete(input.path);
        latest = publicPrototypeSchema.parse({
          content: assembled,
          digest,
          mediaType: input.mediaType,
          path: input.path,
          revision,
        });
      }
      return;
    }

    const digest = sha256(input.content);
    const revision = sha256(
      JSON.stringify({ digest, mediaType: input.mediaType, path: input.path }),
    );
    const size = Buffer.byteLength(input.content, "utf-8");
    if (
      output.data.appId !== appId ||
      output.data.path !== input.path ||
      output.data.mediaType !== input.mediaType ||
      output.data.digest !== digest ||
      output.data.revision !== revision ||
      output.data.size !== size ||
      output.data.recordedByCallId !== callId
    ) {
      return;
    }

    latest = publicPrototypeSchema.parse({
      content: input.content,
      digest,
      mediaType: input.mediaType,
      path: input.path,
      revision,
    });
  };

  return { current: () => latest, observe };
};

export const latestInstalledPrototype = (
  events: readonly MessageStreamEvent[],
): PublicPrototype | undefined => {
  const projector = createInstalledPrototypeProjector();
  for (const event of events) {
    projector.observe(event);
  }
  return projector.current();
};

/** Projects component-backed preview metadata only from a completed tool receipt. */
export const latestInstalledUiPreview = (
  events: readonly MessageStreamEvent[],
): PublicUiPreview | undefined => {
  let latest: PublicUiPreview | undefined;
  for (const event of events) {
    if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.isError === true ||
      event.data.result.toolName !== "record_ui_preview"
    ) {
      continue;
    }
    const preview = uiPreviewResultSchema.safeParse(event.data.result.output);
    if (
      !preview.success ||
      preview.data.complete === false ||
      (preview.data.content !== undefined &&
        sha256(preview.data.content) !== preview.data.digest) ||
      (preview.data.content === undefined && preview.data.requiresChunkedRead !== true)
    ) {
      continue;
    }
    latest = publicUiPreviewSchema.parse({
      appId: preview.data.appId,
      fidelity: preview.data.fidelity,
      functionality: preview.data.functionality,
      revision: preview.data.revision,
      routes: preview.data.routes,
    });
  }
  return latest;
};

/** Keep expired receipts in durable evidence, but never offer them as current previews. */
export const currentWorkingPreview = (
  receipt: PublicWorkingPreview | null | undefined,
  nowMs = Date.now(),
): PublicWorkingPreview | null | undefined =>
  receipt && Date.parse(receipt.expiresAt) <= nowMs ? null : receipt;

/** Only the shared runtime's successful launch receipt can attest to a working app. */
export const latestInstalledWorkingPreview = (
  events: readonly MessageStreamEvent[],
): PublicWorkingPreview | null | undefined => {
  let latest: PublicWorkingPreview | null | undefined;
  for (const event of events) {
    if (
      event.type === "turn.cancelled" ||
      event.type === "turn.failed" ||
      event.type === "session.failed"
    ) {
      latest = null;
      continue;
    }
    if (event.type === "actions.requested") {
      if (
        event.data.actions.some(
          (action) => action.kind === "tool-call" && action.toolName === "start_app_preview",
        )
      ) {
        latest = null;
      }
      continue;
    }
    if (
      event.type !== "action.result" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== "start_app_preview"
    ) {
      continue;
    }
    latest = null;
    if (event.data.status !== "completed" || event.data.result.isError === true) {
      continue;
    }
    const output = z
      .object({ workingPreview: publicWorkingPreviewSchema })
      .safeParse(event.data.result.output);
    if (output.success) {
      latest = output.data.workingPreview;
    }
  }
  return currentWorkingPreview(latest);
};

/** Retains only verified preview metadata while consuming an unbounded event stream. */
export const createInstalledPreviewMetadataReducer = () => {
  let uiPreview: PublicUiPreview | undefined;
  let workingPreview: PublicWorkingPreview | null | undefined;
  return {
    accept(event: MessageStreamEvent) {
      const nextUiPreview = latestInstalledUiPreview([event]);
      if (nextUiPreview !== undefined) {
        uiPreview = nextUiPreview;
      }
      const nextWorkingPreview = latestInstalledWorkingPreview([event]);
      if (nextWorkingPreview !== undefined) {
        workingPreview = nextWorkingPreview;
      }
    },
    snapshot() {
      return {
        ...(uiPreview === undefined ? {} : { uiPreview }),
        ...(workingPreview === undefined
          ? {}
          : { workingPreview: currentWorkingPreview(workingPreview) }),
      };
    },
  };
};

const inputRequest = (request: {
  requestId: string;
  kind: "question" | "session-limit" | "tool-approval";
  prompt: string;
  options?: readonly { id: string; label: string }[];
  allowFreeform?: boolean;
  action?: {
    kind: "tool-call";
    toolName: string;
    input: unknown;
  };
}): PublicInputRequest | undefined => {
  const approvalTitles = {
    apply_app_creation: "Build this app?",
    "publish-github-draft-pr": "Approve draft PR publication",
  } as const;
  const toolName = request.action?.toolName;
  if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    silentInternalApprovalTools.has(toolName)
  ) {
    return undefined;
  }
  const title =
    request.kind === "tool-approval" && toolName !== undefined && toolName in approvalTitles
      ? approvalTitles[toolName as keyof typeof approvalTitles]
      : request.prompt;
  let description: string | undefined;
  if (request.kind === "tool-approval" && toolName === "apply_app_creation") {
    description =
      z
        .object({ productSummary: z.string().trim().min(1).max(600) })
        .safeParse(request.action?.input).data?.productSummary ??
      "Build and validate the preview shown above. This changes only the private App Builder workspace.";
  } else if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles
  ) {
    description = publicApprovalDescription(request.action?.input, toolName);
  }
  if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles &&
    toolName !== "apply_app_creation" &&
    description === undefined
  ) {
    return undefined;
  }
  return {
    allowFreeform: request.allowFreeform ?? false,
    kind: request.kind === "tool-approval" ? "approval" : "question",
    requestId: request.requestId,
    ...(description === undefined ? {} : { description }),
    ...(request.options === undefined
      ? {}
      : { options: request.options.map(({ id, label }) => ({ id, label })) }),
    title,
  };
};

/** Converts only the installed Eve 0.43 events that belong in the public MCP projection. */
export const projectInstalledEveEvent = (
  event: MessageStreamEvent,
  index: number,
  operation?: string,
): InternalEveEvent[] => {
  switch (event.type) {
    case "message.completed": {
      return event.data.message === null
        ? []
        : [
            {
              index,
              text: event.data.message,
              turnId: event.data.turnId,
              type: "assistant.message",
            },
          ];
    }
    case "step.started":
    case "step.completed":
    case "step.failed": {
      let state: "completed" | "failed" | "started";
      if (event.type === "step.started") {
        state = "started";
      } else if (event.type === "step.completed") {
        state = "completed";
      } else {
        state = "failed";
      }
      const progress: InternalEveEvent = {
        index,
        label: "Builder is working on this app",
        state,
        turnId: event.data.turnId,
        type: "progress",
      };
      if (event.type === "step.failed") {
        const failure = publicBuilderFailure(event.data, operation);
        return [
          progress,
          { code: failure.code, index, message: failure.message, type: "error.public" },
        ];
      }
      return [progress];
    }
    case "actions.requested": {
      return event.data.actions.flatMap((action) => {
        if (action.kind !== "tool-call") {
          return [];
        }
        const label = visibleOperations.get(action.toolName);
        return label === undefined ? [] : [{ index, label, state: "started", type: "progress" }];
      });
    }
    case "action.result": {
      if (event.data.result?.kind !== "tool-result") {
        return [];
      }
      const label = visibleOperations.get(event.data.result.toolName);
      return label === undefined
        ? []
        : [
            {
              index,
              label,
              state:
                event.data.status === "completed" && event.data.result.isError !== true
                  ? "completed"
                  : "failed",
              type: "progress",
            },
          ];
    }
    case "input.requested": {
      const projectedRequests = event.data.requests.map(inputRequest);
      return projectedRequests.some((request) => request === undefined)
        ? [
            {
              code: "confirmation_unavailable",
              index,
              message: unavailableConfirmationMessage,
              type: "error.public",
            },
            { index, status: "failed", type: "status" },
          ]
        : projectedRequests.map((request) => ({
            index,
            request,
            type: "input.requested" as const,
          }));
    }
    case "input.resolved": {
      return [
        {
          index,
          requestIds: event.data.resolutions.map(({ requestId }) => requestId),
          type: "input.resolved",
        },
      ];
    }
    case "approval.settled": {
      return [
        {
          index,
          requestIds: [event.data.requestId],
          type: "input.resolved",
        },
      ];
    }
    case "authorization.required": {
      const { authorization } = event.data;
      const authorizationRecord = z.record(z.string(), z.unknown()).safeParse(authorization);
      const repositoryAccess = githubRepositoryAccessSchema.safeParse(
        authorizationRecord.success ? authorizationRecord.data.repositoryAccess : undefined,
      );
      const storeIn = repositoryAccess.success
        ? githubRepositoryAccessViewModel(repositoryAccess.data)
        : undefined;
      return [
        {
          index,
          request: {
            description: storeIn?.description ?? event.data.description,
            kind: "authorization",
            requestId:
              event.data.attemptId ??
              event.data.candidateId ??
              `${event.data.turnId}:${event.data.name}`,
            title: storeIn?.title ?? event.data.name,
            ...(storeIn === undefined
              ? {}
              : {
                  presentation: {
                    control: "provider" as const,
                    section: "store-in" as const,
                  },
                }),
            ...(authorization === undefined
              ? {}
              : {
                  authorization: {
                    ...(authorization.url === undefined ? {} : { url: authorization.url }),
                    ...(authorization.userCode === undefined
                      ? {}
                      : { userCode: authorization.userCode }),
                    ...(authorization.expiresAt === undefined
                      ? {}
                      : { expiresAt: authorization.expiresAt }),
                    ...(authorization.instructions === undefined
                      ? {}
                      : { instructions: authorization.instructions }),
                    ...(authorization.displayName === undefined
                      ? {}
                      : { displayName: authorization.displayName }),
                    ...(repositoryAccess.success
                      ? { repositoryAccess: repositoryAccess.data }
                      : {}),
                  },
                }),
            allowFreeform: false,
          },
          type: "input.requested",
        },
      ];
    }
    case "turn.cancelled": {
      return [{ index, status: "cancelled", type: "status" }];
    }
    case "session.waiting": {
      return [{ index, status: "waiting", type: "status" }];
    }
    case "session.completed": {
      return [{ index, status: "completed", type: "status" }];
    }
    case "turn.failed": {
      const failure = publicBuilderFailure(event.data, operation);
      return [{ code: failure.code, index, message: failure.message, type: "error.public" }];
    }
    case "session.failed": {
      const failure = publicBuilderFailure(event.data, operation);
      return [
        {
          code: failure.code,
          index,
          message: failure.message,
          type: "error.public",
        },
        { index, status: "failed", type: "status" },
      ];
    }
    default: {
      return [];
    }
  }
};

export const outstandingInstalledEveRequests = (
  events: readonly MessageStreamEvent[],
): PublicInputRequest[] => {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested") {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) {
        return [];
      }
      for (const request of event.data.requests) {
        const publicRequest = inputRequest(request);
        if (publicRequest !== undefined) {
          outstanding.set(request.requestId, publicRequest);
        }
      }
    }
    if (event.type === "input.resolved") {
      for (const resolution of event.data.resolutions) {
        outstanding.delete(resolution.requestId);
      }
    }
    if (event.type === "approval.settled") {
      outstanding.delete(event.data.requestId);
    }
  }
  return [...outstanding.values()];
};

export const outstandingInternalEveRequests = (
  events: Iterable<InternalEveEvent>,
): PublicInputRequest[] => {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested" && event.request !== undefined) {
      outstanding.set(event.request.requestId, event.request);
    }
    if (event.type === "input.resolved") {
      for (const requestId of event.requestIds ?? []) {
        outstanding.delete(requestId);
      }
    }
  }
  return [...outstanding.values()];
};

export const deriveInstalledEveStatus = (
  events: readonly MessageStreamEvent[],
): EveSessionStatus => {
  const outstanding = new Set<string>();
  let boundary: EveSessionStatus = "working";
  for (const event of events) {
    if (event.type === "input.requested") {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) {
        return "failed";
      }
      for (const request of projected) {
        if (request !== undefined) {
          outstanding.add(request.requestId);
        }
      }
    }
    if (event.type === "input.resolved") {
      for (const resolution of event.data.resolutions) {
        outstanding.delete(resolution.requestId);
      }
    }
    if (event.type === "approval.settled") {
      outstanding.delete(event.data.requestId);
    }
    if (event.type === "turn.cancelled") {
      boundary = "cancelled";
    }
    if (event.type === "session.waiting") {
      boundary = "waiting";
    }
    if (event.type === "session.completed") {
      boundary = "completed";
    }
    if (event.type === "session.failed") {
      boundary = "failed";
    }
    if (event.type === "step.started") {
      boundary = "working";
    }
  }
  if (boundary === "completed" || boundary === "failed") {
    return boundary;
  }
  if (outstanding.size > 0) {
    return "input_required";
  }
  return boundary;
};

/** Project one durable Eve stream into a dense, cursor-addressable public stream. */
export const toPublicEvent = (event: InternalEveEvent): PublicEveEvent | null => {
  switch (event.type) {
    case "assistant.message": {
      return event.turnId && event.text !== undefined
        ? {
            index: event.index,
            text: event.text,
            turnId: event.turnId,
            type: "assistant_message",
          }
        : null;
    }
    case "progress": {
      return event.label && event.state && progressStates.has(event.state)
        ? {
            index: event.index,
            label: event.label,
            state: event.state as "started" | "completed" | "failed",
            turnId: event.turnId,
            type: "progress",
          }
        : null;
    }
    case "input.requested": {
      return event.request
        ? { index: event.index, request: event.request, type: "input_required" }
        : null;
    }
    case "status": {
      return event.status ? { index: event.index, status: event.status, type: "status" } : null;
    }
    case "error.public": {
      return event.code && event.message
        ? {
            code: event.code,
            index: event.index,
            message: event.message,
            type: "error",
          }
        : null;
    }
    default: {
      return null;
    }
  }
};

export const projectInstalledEveEvents = (
  events: readonly MessageStreamEvent[],
): PublicEveEvent[] => {
  let operation: string | undefined;
  return events
    .flatMap((event) => {
      if (event.type === "actions.requested") {
        const requested = event.data.actions.filter((action) => action.kind === "tool-call");
        operation = requested.at(-1)?.toolName ?? operation;
      }
      return projectInstalledEveEvent(event, 0, operation);
    })
    .flatMap((event) => {
      const projected = toPublicEvent(event);
      return projected === null ? [] : [projected];
    })
    .map((event, index) => ({ ...event, index }));
};

/** Allowlist an internal event. Unknown, reasoning, and raw tool events are dropped. */
