import {
  PRIVATE_COMPUTE_PROFILE_ID,
  privateComputeApprovalDescription,
} from "../sandbox/private-compute-profile";
import { isFrameworkSessionLimitInput } from "./session-limit-input";
import { createHash } from "node:crypto";

import {
  publicIdentityInvitationSchema,
  publicPrototypeSchema,
  publicPrototypeReferenceSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
} from "../mcp/contracts";
import type {
  EveSessionResult,
  EveSessionStatus,
  PublicEveEvent,
  PublicInputRequest,
  PublicIdentityInvitation,
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

const preparingAppDataModelLabel = "Preparing the app's data model";
const prepareHostedRuntimeTool = "prepare-app-hosted-runtime";
const prepareAppProductionTool = "prepare-app-production";
const actionsRequestedEvent = "actions.requested";
const actionResultEvent = "action.result";
const toolResultKind = "tool-result";
const turnCancelledEvent = "turn.cancelled";
const sessionFailedEvent = "session.failed";
const toolApprovalKind = "tool-approval";
const assistantMessageEvent = "assistant.message";
const stepStartedEvent = "step.started";
const publicErrorEvent = "error.public";
const inputRequestedEvent = "input.requested";
const inputResolvedEvent = "input.resolved";
const approvalSettledEvent = "approval.settled";
const authorizationRequiredEvent = "authorization.required";
const authorizationCompletedEvent = "authorization.completed";

export interface InternalEveEvent {
  type: string;
  index: number;
  turnId?: string;
  text?: string;
  label?: string;
  state?: string;
  request?: PublicInputRequest;
  frameworkSessionLimit?: boolean;
  code?: string;
  message?: string;
  status?: EveSessionStatus;
  requestIds?: string[];
  resolutionKind?: "authorization";
  identityInvitation?: PublicIdentityInvitation;
  callId?: string;
  operationRef?: string;
}

const authorizationCoordinatesSchema = z.object({
  attemptId: z.string().min(1).optional(),
  candidateId: z.string().min(1).optional(),
  name: z.string().min(1),
  turnId: z.string().min(1),
});
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const authorizationRequestId = (data: unknown): string | undefined => {
  const coordinates = authorizationCoordinatesSchema.safeParse(data);
  if (!coordinates.success) {
    return undefined;
  }
  return (
    coordinates.data.attemptId ??
    coordinates.data.candidateId ??
    `${coordinates.data.turnId}:${coordinates.data.name}`
  );
};

const progressStates = new Set(["started", "completed", "failed"]);
const isProgressState = (value: string): value is "started" | "completed" | "failed" =>
  progressStates.has(value);
const visibleOperations = new Map([
  ["apply_app_creation", "Building the app in its private workspace"],
  ["compile-app-schema-release", preparingAppDataModelLabel],
  ["install-app-integrations", "Installing the app's requested integrations"],
  ["prepare-app-local-preview", "Preparing the app's local preview dependencies"],
  [prepareHostedRuntimeTool, "Setting up your app’s data"],
  ["plan-app-production", "Preparing your app’s setup"],
  [prepareAppProductionTool, "Setting up your app’s data and access"],
  ["get-app-production", "Checking your app’s setup"],
  ["cleanup-app-hosted-runtime", "Removing the app's Preview resources"],
  ["export-app-hosted-data", "Exporting approved app data privately"],
  ["run-app-continuity-tests", "Checking that the app stays connected after restart"],
  ["run-app-browser-tests", "Running the app's browser tests"],
  ["start_app_preview", "Starting the app preview"],
  ["validate_app_creation", "Validating the app changes"],
  ["validate-app-creation", "Validating the app changes"],
  ["validate_github_draft_pr_reconciliation", "Checking changes proposed for the draft PR"],
  ["reconcile_github_draft_pr", "Updating the draft pull request"],
]);
const visibleOperationLabels = new Set([
  ...visibleOperations.values(),
  "Preparing the app's dependencies",
  preparingAppDataModelLabel,
  "Checking the app's data model",
  "Running app tests",
  "Checking the app's workflow",
  "Preparing local app data",
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const draftValidationCommandLabel = (value: unknown): string | undefined => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof value !== "string") {
    return undefined;
  }
  if (/^mise exec (?:--no-deps )?-- bun install --frozen-lockfile$/u.test(value)) {
    return "Preparing the app's dependencies";
  }
  if (/^mise run (?:--no-deps )?app:compile [a-z][a-z0-9-]*$/u.test(value)) {
    return preparingAppDataModelLabel;
  }
  if (
    /^mise run (?:--no-deps )?--skip-tools schema:release -- compile --app [a-z][a-z0-9-]*$/u.test(
      value,
    )
  ) {
    return preparingAppDataModelLabel;
  }
  if (/^mise run (?:--no-deps )?--skip-tools app:check [a-z][a-z0-9-]*$/u.test(value)) {
    return "Checking the app's data model";
  }
  if (
    /^mise run (?:--no-deps )?--skip-tools app:test [a-z][a-z0-9-]* [1-9][0-9]*\/[1-9][0-9]*$/u.test(
      value,
    )
  ) {
    return "Running app tests";
  }
  if (/^mise run (?:--no-deps )?--skip-tools \/\/apps\/[a-z][a-z0-9-]*:test-e2e$/u.test(value)) {
    return "Checking the app's workflow";
  }
  const local =
    /mise run (?:--no-deps )?(?:app:local -- |app:runtime prepare )(?<appId>[a-z][a-z0-9-]*)(?: setup| local)/u.exec(
      value,
    );
  return local?.groups?.appId === undefined ? undefined : "Preparing local app data";
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const recordStringField = (value: unknown, key: string): string | undefined => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  const field = (value as Record<string, unknown>)[key];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  return typeof field === "string" ? field : undefined;
};

const draftValidationLabel = (
  toolName: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  value: unknown,
  requested: boolean,
): string | undefined => {
  if (toolName !== "validate_github_draft_pr_reconciliation") {
    return visibleOperations.get(toolName);
  }
  const command = recordStringField(value, requested ? "expectedCommand" : "command");
  return draftValidationCommandLabel(command) ?? visibleOperations.get(toolName);
};

export const pendingBuilderOperation = (events: Iterable<PublicEveEvent>): string => {
  const pending = new Set<string>();
  // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Track pending operations across terminal and progress events.
  for (const event of events) {
    if (event.type === "status" && ["cancelled", "completed", "failed"].includes(event.status)) {
      pending.clear();
      continue;
    }
    if (event.type !== "progress" || !visibleOperationLabels.has(event.label)) {
      continue;
    }
    if (event.state === "started") {
      pending.add(event.label);
    } else if (event.state === "failed") {
      // A failed tool result may omit its command. The generic failure closes the active command.
      pending.clear();
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
  const operationLabels = {
    apply_app_creation: "the private build",
    "cleanup-app-hosted-runtime": "Preview cleanup",
    "prepare-app-hosted-runtime": "Preview setup",
    "prepare-app-production": "app setup",
    "publish-github-draft-pr": "draft pull request publication",
    publish_github_draft_pr: "draft pull request publication",
    reconcile_github_draft_pr: "draft pull request update",
    start_app_preview: "the app preview",
    "validate-app-creation": "app validation",
    validate_app_creation: "app validation",
    validate_github_draft_pr_reconciliation: "draft pull request checks",
  } as const satisfies Record<string, string>;
  const name =
    operation !== undefined && Object.hasOwn(operationLabels, operation)
      ? operationLabels[operation as keyof typeof operationLabels]
      : "this Builder step";
  const size =
    /Chunk size (?<actual>\d+) exceeds maximum allowed size of (?<maximum>\d+) bytes/u.exec(
      failure.message,
    );
  if (size?.groups !== undefined) {
    return {
      code: "result_too_large",
      message: `Builder could not finish ${name} because it could not transfer the preview content. Your progress is saved; resume this same session to continue.`,
    };
  }
  const code = publicErrorCode(failure.code);
  const detail = publicFailureDetail(failure.message);
  if (detail.length === 0) {
    return {
      code,
      message: `Builder could not finish ${name}. No further detail was provided. Retry this saved session once; if the problem continues, contact support with the session ID and error code.`,
    };
  }
  return {
    code,
    message: `Builder could not finish ${name}. Your progress is saved; resume this same session to continue.\n\nDetails: ${detail}`,
  };
};
// Browser projection accepts only HTML; Markdown AppSpec/decision artifacts never become previews.
const prototypePathPattern = /^prototype\/(?<appId>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/index\.html$/u;
const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");
const prototypeRequestSchema = z
  .strictObject({
    baseRevision: lowercaseSha256Schema.optional(),
    chunkIndex: z.number().int().nonnegative().optional(),
    content: z.string().min(1),
    expectedDigest: lowercaseSha256Schema.optional(),
    finalChunk: z.boolean().optional(),
    mediaType: z.literal("text/html"),
    path: z.string().regex(prototypePathPattern),
  })
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
const prototypeResultSchema = z.strictObject({
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
});

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
  .loose();

export const installedPrototypeReferenceStateSchema = z.strictObject({
  latest: publicPrototypeReferenceSchema.optional(),
  requested: z.array(z.tuple([z.string(), prototypeRequestSchema])),
  requestedUiPreview: z.array(z.tuple([z.string(), z.string()])),
});
export type InstalledPrototypeReferenceState = z.infer<
  typeof installedPrototypeReferenceStateSchema
>;

export const installedPrototypeProjectorStateSchema = z.strictObject({
  artifactReadRequests: z.array(
    z.tuple([
      z.string(),
      z.strictObject({
        digest: lowercaseSha256Schema,
        offsetBytes: z.number().int().nonnegative().optional(),
        path: z.string(),
        revision: lowercaseSha256Schema.optional(),
      }),
    ]),
  ),
  expectedChunkedPreview: z
    .strictObject({
      digest: lowercaseSha256Schema,
      path: z.string(),
      revision: lowercaseSha256Schema,
    })
    .optional(),
  latest: publicPrototypeSchema.optional(),
  readChunks: z.array(
    z.tuple([
      z.string(),
      z.strictObject({
        chunks: z.array(z.string()),
        digest: lowercaseSha256Schema,
        mediaType: z.literal("text/html"),
        nextOffsetBytes: z.number().int().nonnegative(),
        path: z.string(),
        revision: lowercaseSha256Schema,
        totalBytes: z.number().int().positive(),
      }),
    ]),
  ),
  requested: z.array(z.tuple([z.string(), prototypeRequestSchema])),
  transfers: z.array(
    z.tuple([
      z.string(),
      z.strictObject({
        chunks: z.array(z.string()),
        expectedDigest: lowercaseSha256Schema,
        lastCallId: z.string(),
        lastChunkDigest: lowercaseSha256Schema,
        lastChunkIndex: z.number().int().nonnegative(),
        nextChunkIndex: z.number().int().nonnegative(),
        receivedBytes: z.number().int().nonnegative(),
        revision: lowercaseSha256Schema,
        rollingDigest: lowercaseSha256Schema,
      }),
    ]),
  ),
});
export type InstalledPrototypeProjectorState = z.infer<
  typeof installedPrototypeProjectorStateSchema
>;

/** Projects v2 manifests only from a matching completed tool receipt. */
export const createInstalledPrototypeReferenceReducer = (input: {
  sessionId: string;
  state?: InstalledPrototypeReferenceState;
}) => {
  const state =
    input.state === undefined
      ? undefined
      : installedPrototypeReferenceStateSchema.parse(input.state);
  const requested = new Map<string, z.infer<typeof prototypeRequestSchema>>(state?.requested);
  const requestedUiPreview = new Map<string, string>(state?.requestedUiPreview);
  let latest: PublicPrototypeReference | undefined = state?.latest;
  return {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
    accept(candidate: unknown) {
      const event = z.object({ data: z.unknown(), type: z.string() }).loose().safeParse(candidate);
      if (!event.success) {
        return;
      }
      if (event.data.type === actionsRequestedEvent) {
        const actions = z
          .object({ actions: z.array(z.unknown()) })
          .loose()
          .safeParse(event.data.data);
        if (!actions.success) {
          return;
        }
        // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Inspect each action without emitting invalid approval requests.
        for (const candidateAction of actions.data.actions) {
          const action = z
            .object({
              callId: z.string(),
              input: z.unknown(),
              kind: z.string(),
              toolName: z.string(),
            })
            .loose()
            .safeParse(candidateAction);
          if (!action.success || action.data.kind !== "tool-call") {
            continue;
          }
          const { callId } = action.data;
          if (action.data.toolName !== "record_prototype_artifact") {
            requested.delete(callId);
            if (action.data.toolName === "record_ui_preview") {
              const preview = z
                .object({ appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u) })
                .loose()
                .safeParse(action.data.input);
              if (preview.success) {
                requestedUiPreview.set(callId, preview.data.appId);
              }
            } else {
              requestedUiPreview.delete(callId);
            }
            continue;
          }
          requestedUiPreview.delete(callId);
          const parsed = prototypeRequestSchema.safeParse(action.data.input);
          if (parsed.success) {
            requested.set(callId, parsed.data);
          }
        }
        return;
      }
      if (event.data.type !== actionResultEvent) {
        return;
      }
      const resultEvent = z
        .object({
          result: z
            .object({
              callId: z.string(),
              isError: z.boolean().optional(),
              kind: z.literal(toolResultKind),
              output: z.unknown(),
              toolName: z.enum(["record_prototype_artifact", "record_ui_preview"]),
            })
            .loose(),
          status: z.literal("completed"),
        })
        .loose()
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
          .loose()
          .safeParse(receipt.output);
        if (!output.success) {
          return;
        }
        const value = output.data;
        if (
          value.appId !== appId ||
          value.path !== `prototype/${appId}/index.html` ||
          value.sessionId !== input.sessionId ||
          value.recordedByCallId !== receipt.callId
        ) {
          return;
        }
        if (
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
        value.path !== request.path
      ) {
        return;
      }
      if (
        value.mediaType !== request.mediaType ||
        value.revision !== revision ||
        (request.expectedDigest !== undefined && value.digest !== request.expectedDigest)
      ) {
        return;
      }
      if (
        request.chunkIndex !== undefined &&
        (request.finalChunk !== true || value.chunkCount !== request.chunkIndex + 1)
      ) {
        return;
      }
      if (
        request.chunkIndex === undefined &&
        (value.digest !== sha256(request.content) ||
          value.contentBytes !== Buffer.byteLength(request.content, "utf-8"))
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
    checkpoint: (): InstalledPrototypeReferenceState => {
      const checkpoint: InstalledPrototypeReferenceState = {
        requested: [...requested],
        requestedUiPreview: [...requestedUiPreview],
      };
      if (latest !== undefined) {
        checkpoint.latest = latest;
      }
      return installedPrototypeReferenceStateSchema.parse(checkpoint);
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
  .loose();

/**
 * Recovers only a successfully recorded HTML prototype from Eve's durable
 * action stream. Raw tool input is never projected without its matching,
 * completed receipt.
 */
export interface InstalledPrototypeProjector {
  observe: (event: MessageStreamEvent) => void;
  current: () => PublicPrototype | undefined;
  checkpoint: () => InstalledPrototypeProjectorState;
}

export const createInstalledPrototypeProjector = (
  seed?: InstalledPrototypeProjectorState,
): InstalledPrototypeProjector => {
  const state = seed === undefined ? undefined : installedPrototypeProjectorStateSchema.parse(seed);
  const requested = new Map<string, z.infer<typeof prototypeRequestSchema>>(state?.requested);
  const artifactReadRequests = new Map<
    string,
    { path: string; digest: string; revision?: string; offsetBytes?: number }
  >(state?.artifactReadRequests);
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
  >(state?.readChunks);
  let expectedChunkedPreview: { path: string; digest: string; revision: string } | undefined =
    state?.expectedChunkedPreview;
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
  >(state?.transfers);
  let latest: PublicPrototype | undefined = state?.latest;

  const observe = (event: MessageStreamEvent): void => {
    if (event.type === actionsRequestedEvent) {
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
      event.type !== actionResultEvent ||
      event.data.status !== "completed" ||
      event.data.result.kind !== toolResultKind ||
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
      if (input === undefined || !output.success || input.path !== output.data.path) {
        return;
      }
      if (
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
      if (nextOffsetBytes === undefined || totalBytes === undefined || chunkDigest === undefined) {
        readChunks.delete(output.data.path);
        return;
      }
      if (
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
        // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
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
          // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
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
          // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
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
          output.data.path !== input.path
        ) {
          transfers.delete(input.path);
          return;
        }
        if (
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
        output.data.mediaType !== input.mediaType
      ) {
        transfers.delete(input.path);
        return;
      }
      if (
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
      output.data.mediaType !== input.mediaType
    ) {
      return;
    }
    if (
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

  return {
    checkpoint: () => {
      const checkpoint: InstalledPrototypeProjectorState = {
        artifactReadRequests: [...artifactReadRequests],
        readChunks: [...readChunks],
        requested: [...requested],
        transfers: [...transfers],
      };
      if (expectedChunkedPreview !== undefined) {
        checkpoint.expectedChunkedPreview = expectedChunkedPreview;
      }
      if (latest !== undefined) {
        checkpoint.latest = latest;
      }
      return installedPrototypeProjectorStateSchema.parse(checkpoint);
    },
    current: () => latest,
    observe,
  };
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
  // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Select the latest completed UI preview from ordered events.
  for (const event of events) {
    if (event.type !== actionResultEvent || event.data.status !== "completed") {
      continue;
    }
    if (
      event.data.result.kind !== toolResultKind ||
      event.data.result.isError === true ||
      event.data.result.toolName !== "record_ui_preview"
    ) {
      continue;
    }
    const preview = uiPreviewResultSchema.safeParse(event.data.result.output);
    if (!preview.success || preview.data.complete === false) {
      continue;
    }
    const { content } = preview.data;
    if (
      (content !== undefined && sha256(content) !== preview.data.digest) ||
      (content === undefined && preview.data.requiresChunkedRead !== true)
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
  // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Track working preview changes and failures in event order.
  for (const event of events) {
    if (
      event.type === turnCancelledEvent ||
      event.type === "turn.failed" ||
      event.type === sessionFailedEvent
    ) {
      latest = null;
      continue;
    }
    if (event.type === actionsRequestedEvent) {
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
      event.type !== actionResultEvent ||
      event.data.result.kind !== toolResultKind ||
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
      const snapshot: Pick<EveSessionResult, "uiPreview" | "workingPreview"> = {};
      if (uiPreview !== undefined) {
        snapshot.uiPreview = uiPreview;
      }
      if (workingPreview !== undefined) {
        snapshot.workingPreview = currentWorkingPreview(workingPreview);
      }
      return snapshot;
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
    "cleanup-app-hosted-runtime": "Remove this app's Preview resources?",
    "export-app-hosted-data": "Export this customer’s app data privately?",
    "finish-github-pr-delivery": "Merge the reviewed changes when checks pass?",
    "prepare-app-hosted-runtime": "Do you approve creating a preview?",
    "prepare-app-native-target": "Create this app's Preview project?",
    "prepare-app-production": "Set up your app’s data and access?",
    "publish-github-draft-pr": "Publish the reviewed changes?",
    publish_github_draft_pr: "Publish the reviewed changes?",
    reconcile_github_draft_pr: "Update the draft pull request?",
    "run-app-continuity-tests": "Run this app continuity suite?",
    update_github_draft_pr: "Update the draft pull request?",
  } as const;
  const toolName = request.action?.toolName;
  if (
    request.kind === toolApprovalKind &&
    toolName !== undefined &&
    silentInternalApprovalTools.has(toolName)
  ) {
    return undefined;
  }
  const title =
    request.kind === toolApprovalKind && toolName !== undefined && toolName in approvalTitles
      ? approvalTitles[toolName as keyof typeof approvalTitles]
      : request.prompt;
  let description: string | undefined;
  if (request.kind === toolApprovalKind && toolName === prepareAppProductionTool) {
    const setup = z
      .object({
        scope: z.object({ appId: z.string(), repositoryFullName: z.string() }),
        intent: z.object({
          creatorRoles: z.array(z.string()),
          creatorEmail: z.email().optional(),
          storage: z.object({ kind: z.enum(["none", "postgres"]) }),
        }),
      })
      .safeParse(request.action?.input);
    if (setup.success) {
      const { scope, intent } = setup.data;
      const account =
        intent.creatorEmail === undefined
          ? "Connect your app account once to receive access."
          : `Use ${intent.creatorEmail} for your app account and verify it through secure sign-in.`;
      description = `Set up ${scope.appId} in ${scope.repositoryFullName}. ${intent.storage.kind === "postgres" ? "Builder prepares the app’s database and keeps it for future updates. " : "This app does not need a database. "}${account} Other people get access only when invited.`;
    }
  } else if (request.kind === toolApprovalKind && toolName === "apply_app_creation") {
    // Use the standard card copy when the optional summary does not fit the card.
    description =
      z
        .object({ productSummary: z.string().trim().min(1).max(600) })
        .safeParse(request.action?.input).data?.productSummary ??
      "Build and validate the app shown above in your private workspace. This does not publish or deploy it.";
    if (
      z
        .object({ privateCompute: z.literal(PRIVATE_COMPUTE_PROFILE_ID) })
        .safeParse(request.action?.input).success
    ) {
      description = `${description} ${privateComputeApprovalDescription}`;
    }
  } else if (
    request.kind === toolApprovalKind &&
    toolName !== undefined &&
    toolName in approvalTitles
  ) {
    description = publicApprovalDescription(request.action?.input, toolName);
  }
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
    request.kind === toolApprovalKind &&
    toolName !== undefined &&
    toolName in approvalTitles &&
    toolName !== "apply_app_creation" &&
    description === undefined
  ) {
    return undefined;
  }
  const header: Pick<PublicInputRequest, "allowFreeform" | "kind" | "requestId"> = {
    allowFreeform: request.allowFreeform ?? false,
    kind: request.kind === toolApprovalKind ? "approval" : "question",
    requestId: request.requestId,
  };
  const details: Pick<PublicInputRequest, "description" | "options"> = {};
  if (description !== undefined) {
    details.description = description;
  }
  if (request.options !== undefined) {
    details.options = request.options.map(({ id, label }) => ({ id, label }));
  }
  return {
    ...header,
    ...details,
    title,
  };
};

/** Only the ordinary invitation is public; the rest of a suspended tool result stays private. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const hostedIdentityInvitation = (value: unknown): string | undefined => {
  const invitation = z
    .object({ authIdentityLink: z.url().startsWith("https://") })
    .safeParse(value);
  if (!invitation.success) {
    return undefined;
  }
  const url = new URL(invitation.data.authIdentityLink);
  if (url.username !== "" || url.password !== "" || /[\r\n<>]/u.test(url.href)) {
    return undefined;
  }
  return `Sign in or create your app account: <${url.href}>. Builder sets up your access and continues automatically.`;
};

const productionSetupStatusSchema = z.object({
  operationRef: z.uuid(),
  state: z.enum([
    "ready",
    "identity-required",
    "setting-up-data",
    "checking-access",
    "reconciling",
  ]),
  signInUrl: z.string().optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

/** Only the ordinary account link and its setup correlation leave the protected result. */
const productionIdentityEvents = (
  result: { toolName: string; callId: string; output: unknown },
  index: number,
  turnId: string,
): InternalEveEvent[] => {
  const isPrepare = result.toolName === prepareAppProductionTool;
  if (!isPrepare && result.toolName !== "get-app-production") {
    return [];
  }
  let { output } = result;
  let expiresAt: string | undefined;
  if (isPrepare) {
    const prepared = z
      .object({
        creator: z.object({ expiresAt: z.string().optional() }).optional(),
        setup: productionSetupStatusSchema,
      })
      .safeParse(output);
    if (!prepared.success) {
      return [];
    }
    output = prepared.data.setup;
    expiresAt = prepared.data.creator?.expiresAt;
  }
  const status = productionSetupStatusSchema.safeParse(output);
  if (!status.success) {
    return [];
  }
  const { operationRef } = status.data;
  if (status.data.state === "ready") {
    return [
      { index, type: "auth_identity_invitation_resolved", callId: result.callId, operationRef },
    ];
  }
  if (status.data.state !== "identity-required") {
    return [];
  }
  const invitation = publicIdentityInvitationSchema.safeParse({
    callId: result.callId,
    operationRef,
    url: status.data.signInUrl,
    expiresAt: status.data.expiresAt ?? expiresAt,
  });
  const text = invitation.success
    ? hostedIdentityInvitation({ authIdentityLink: invitation.data.url })
    : undefined;
  if (!invitation.success || text === undefined) {
    return [];
  }
  return [
    {
      index,
      text,
      turnId: `${turnId}:identity-invitation:${result.callId}`,
      type: assistantMessageEvent,
    },
    { index, type: "auth_identity_invitation", identityInvitation: invitation.data },
  ];
};

/** Converts only the installed Eve 0.68 events that belong in the public MCP projection. */
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
              type: assistantMessageEvent,
            },
          ];
    }
    case stepStartedEvent:
    case "step.completed":
    case "step.failed": {
      let state: "completed" | "failed" | "started";
      if (event.type === stepStartedEvent) {
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
          { code: failure.code, index, message: failure.message, type: publicErrorEvent },
        ];
      }
      return [progress];
    }
    case actionsRequestedEvent: {
      return event.data.actions.flatMap((action) => {
        if (action.kind !== "tool-call") {
          return [];
        }
        const label = draftValidationLabel(action.toolName, action.input, true);
        return label === undefined ? [] : [{ index, label, state: "started", type: "progress" }];
      });
    }
    case "action.partial": {
      const { result, turnId, sequence } = event.data;
      if (
        result.kind !== toolResultKind ||
        result.toolName !== prepareHostedRuntimeTool ||
        result.isError === true
      ) {
        return [];
      }
      const text = hostedIdentityInvitation(result.output);
      if (text === undefined) {
        return [];
      }
      const invitation = publicIdentityInvitationSchema.safeParse({
        callId: result.callId,
        url: recordStringField(result.output, "authIdentityLink"),
        expiresAt: recordStringField(result.output, "authIdentityLinkExpiresAt"),
      });
      return [
        {
          index,
          text,
          // Keep a yielded invitation distinct from the later model reply, stable on replay.
          turnId: `${turnId}:identity-invitation:${result.callId}:${sequence}`,
          type: assistantMessageEvent,
        },
        ...(invitation.success
          ? [{ index, type: "auth_identity_invitation", identityInvitation: invitation.data }]
          : []),
      ];
    }
    case actionResultEvent: {
      if (event.data.result?.kind !== toolResultKind) {
        return [];
      }
      const label = draftValidationLabel(
        event.data.result.toolName,
        event.data.result.output,
        false,
      );
      const returnedStatus = recordStringField(event.data.result.output, "status");
      const commandFailed =
        // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
        (event.data.result.toolName === prepareHostedRuntimeTool && returnedStatus === "blocked") ||
        (event.data.result.toolName === "validate_github_draft_pr_reconciliation" &&
          (returnedStatus === "needs_repair" || returnedStatus === "needs_resolution")) ||
        (event.data.result.toolName === "install-app-integrations" && returnedStatus === "failed");
      const progress: InternalEveEvent[] =
        label === undefined
          ? []
          : [
              {
                index,
                label,
                state:
                  event.data.status === "completed" &&
                  event.data.result.isError !== true &&
                  !commandFailed
                    ? "completed"
                    : "failed",
                type: "progress",
              },
            ];
      return event.data.result.toolName === prepareHostedRuntimeTool
        ? [
            ...progress,
            { index, type: "auth_identity_invitation_resolved", callId: event.data.result.callId },
          ]
        : [
            ...progress,
            ...(event.data.status === "completed" && event.data.result.isError !== true
              ? productionIdentityEvents(event.data.result, index, event.data.turnId)
              : []),
          ];
    }
    case inputRequestedEvent: {
      const projectedRequests = event.data.requests.map(inputRequest);
      return projectedRequests.some((request) => request === undefined)
        ? [
            {
              code: "confirmation_unavailable",
              index,
              message: unavailableConfirmationMessage,
              type: publicErrorEvent,
            },
            { index, status: "failed", type: "status" },
          ]
        : projectedRequests.map((request, requestIndex) => {
            const projected: InternalEveEvent = { index, request, type: inputRequestedEvent };
            if (isFrameworkSessionLimitInput(event.data.requests[requestIndex])) {
              projected.frameworkSessionLimit = true;
            }
            return projected;
          });
    }
    case inputResolvedEvent: {
      return [
        {
          index,
          requestIds: event.data.resolutions.map(({ requestId }) => requestId),
          type: inputResolvedEvent,
        },
      ];
    }
    case approvalSettledEvent: {
      return [
        {
          index,
          requestIds: [event.data.requestId],
          type: inputResolvedEvent,
        },
      ];
    }
    case authorizationRequiredEvent: {
      const requestId = authorizationRequestId(event.data);
      if (requestId === undefined) {
        return [];
      }
      const { authorization } = event.data;
      const authorizationRecord = z.record(z.string(), z.unknown()).safeParse(authorization);
      const repositoryAccess = githubRepositoryAccessSchema.safeParse(
        authorizationRecord.success ? authorizationRecord.data.repositoryAccess : undefined,
      );
      const storeIn = repositoryAccess.success
        ? githubRepositoryAccessViewModel(repositoryAccess.data)
        : undefined;
      const request: Pick<
        PublicInputRequest,
        "description" | "kind" | "requestId" | "title" | "presentation" | "authorization"
      > = {
        description: storeIn?.description ?? event.data.description,
        kind: "authorization",
        requestId,
        title: storeIn?.title ?? event.data.name,
      };
      if (storeIn !== undefined) {
        request.presentation = { control: "provider", section: "store-in" };
      }
      if (authorization !== undefined) {
        const challenge: NonNullable<PublicInputRequest["authorization"]> = {};
        if (authorization.url !== undefined) {
          challenge.url = authorization.url;
        }
        if (authorization.userCode !== undefined) {
          challenge.userCode = authorization.userCode;
        }
        if (authorization.expiresAt !== undefined) {
          challenge.expiresAt = authorization.expiresAt;
        }
        if (authorization.instructions !== undefined) {
          challenge.instructions = authorization.instructions;
        }
        if (authorization.displayName !== undefined) {
          challenge.displayName = authorization.displayName;
        }
        if (repositoryAccess.success) {
          challenge.repositoryAccess = repositoryAccess.data;
        }
        request.authorization = challenge;
      }
      return [
        {
          index,
          request: { ...request, allowFreeform: false },
          type: inputRequestedEvent,
        },
      ];
    }
    case authorizationCompletedEvent: {
      const requestId = authorizationRequestId(event.data);
      const outcome = z
        .enum(["authorized", "declined", "failed", "timed-out"])
        .safeParse(event.data.outcome);
      return requestId === undefined || !outcome.success
        ? []
        : [
            {
              index,
              requestIds: [requestId],
              resolutionKind: "authorization",
              type: inputResolvedEvent,
            },
          ];
    }
    case turnCancelledEvent: {
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
      return [{ code: failure.code, index, message: failure.message, type: publicErrorEvent }];
    }
    case sessionFailedEvent: {
      const failure = publicBuilderFailure(event.data, operation);
      return [
        {
          code: failure.code,
          index,
          message: failure.message,
          type: publicErrorEvent,
        },
        { index, status: "failed", type: "status" },
      ];
    }
    case "action.input.appended":
    case "approval.candidate":
    case "compaction.completed":
    case "compaction.requested":
    case "context.cleared":
    case "message.appended":
    case "message.received":
    case "reasoning.appended":
    case "reasoning.completed":
    case "result.completed":
    case "session.started":
    case "subagent.called":
    case "subagent.completed":
    case "subagent.event":
    case "subagent.started":
    case "turn.completed":
    case "turn.started": {
      return [];
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
    if (event.type === authorizationRequiredEvent || event.type === authorizationCompletedEvent) {
      for (const projected of projectInstalledEveEvent(event, 0)) {
        if (projected.request !== undefined) {
          outstanding.set(projected.request.requestId, projected.request);
        }
        for (const requestId of projected.requestIds ?? []) {
          if (outstanding.get(requestId)?.kind === "authorization") {
            outstanding.delete(requestId);
          }
        }
      }
    }
    if (event.type === inputRequestedEvent) {
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
    if (event.type === inputResolvedEvent) {
      for (const resolution of event.data.resolutions) {
        outstanding.delete(resolution.requestId);
      }
    }
    if (event.type === approvalSettledEvent) {
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
    if (event.type === inputRequestedEvent && event.request !== undefined) {
      outstanding.set(event.request.requestId, event.request);
    }
    if (event.type === inputResolvedEvent) {
      for (const requestId of event.requestIds ?? []) {
        if (
          event.resolutionKind !== "authorization" ||
          outstanding.get(requestId)?.kind === "authorization"
        ) {
          outstanding.delete(requestId);
        }
      }
    }
  }
  return [...outstanding.values()];
};

export const deriveInstalledEveStatus = (
  events: readonly MessageStreamEvent[],
): EveSessionStatus => {
  const outstanding = new Map<string, PublicInputRequest["kind"]>();
  let boundary: EveSessionStatus = "working";
  for (const event of events) {
    if (event.type === inputRequestedEvent) {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) {
        return "failed";
      }
      for (const request of projected) {
        if (request !== undefined) {
          outstanding.set(request.requestId, request.kind);
        }
      }
    }
    if (event.type === inputResolvedEvent) {
      for (const resolution of event.data.resolutions) {
        outstanding.delete(resolution.requestId);
      }
    }
    if (event.type === approvalSettledEvent) {
      outstanding.delete(event.data.requestId);
    }
    if (event.type === authorizationRequiredEvent || event.type === authorizationCompletedEvent) {
      for (const projected of projectInstalledEveEvent(event, 0)) {
        if (projected.request !== undefined) {
          outstanding.set(projected.request.requestId, projected.request.kind);
        }
        for (const requestId of projected.requestIds ?? []) {
          if (outstanding.get(requestId) === "authorization") {
            outstanding.delete(requestId);
          }
        }
      }
    }
    if (event.type === turnCancelledEvent) {
      boundary = "cancelled";
    }
    if (event.type === "session.waiting") {
      boundary = "waiting";
    }
    if (event.type === "session.completed") {
      boundary = "completed";
    }
    if (event.type === sessionFailedEvent) {
      boundary = "failed";
    }
    if (event.type === stepStartedEvent) {
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
    case "auth_identity_invitation": {
      const invitation = publicIdentityInvitationSchema.safeParse(event.identityInvitation);
      return invitation.success
        ? { ...invitation.data, index: event.index, type: "auth_identity_invitation" }
        : null;
    }
    case "auth_identity_invitation_resolved": {
      const resolved = z
        .object({ callId: z.string().min(1), operationRef: z.uuid().optional() })
        .safeParse(event);
      return resolved.success
        ? { ...resolved.data, index: event.index, type: "auth_identity_invitation_resolved" }
        : null;
    }
    case assistantMessageEvent: {
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
      if (!(event.label && event.state && isProgressState(event.state))) {
        return null;
      }
      const progress: Pick<
        Extract<PublicEveEvent, { type: "progress" }>,
        "index" | "label" | "state" | "turnId"
      > = {
        index: event.index,
        label: event.label,
        state: event.state,
      };
      if (event.turnId !== undefined) {
        progress.turnId = event.turnId;
      }
      return { ...progress, type: "progress" };
    }
    case inputRequestedEvent: {
      return event.request && event.frameworkSessionLimit !== true
        ? { index: event.index, request: event.request, type: "input_required" }
        : null;
    }
    case "status": {
      return event.status ? { index: event.index, status: event.status, type: "status" } : null;
    }
    case publicErrorEvent: {
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
  const internalEvents = events.flatMap((event) => {
    if (event.type === actionsRequestedEvent) {
      const requested = event.data.actions.filter((action) => action.kind === "tool-call");
      operation = requested.at(-1)?.toolName ?? operation;
    }
    return projectInstalledEveEvent(event, 0, operation);
  });
  const publicEvents: PublicEveEvent[] = [];
  for (const event of internalEvents) {
    const projected = toPublicEvent(event);
    if (projected !== null) {
      publicEvents.push({ ...projected, index: publicEvents.length });
    }
  }
  return publicEvents;
};

/** Allowlist an internal event. Unknown, reasoning, and raw tool events are dropped. */
