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
  frameworkSessionLimit?: boolean;
  code?: string;
  message?: string;
  status?: EveSessionStatus;
  requestIds?: string[];
  resolutionKind?: "authorization";
  identityInvitation?: { callId: string; url: string; expiresAt: string };
  callId?: string;
}

const authorizationCoordinatesSchema = z.object({
  attemptId: z.string().min(1).optional(),
  candidateId: z.string().min(1).optional(),
  name: z.string().min(1),
  turnId: z.string().min(1),
});
const authorizationRequestId = (
  data: z.input<typeof authorizationCoordinatesSchema>,
): string | undefined => {
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

const PREVIEW_START_TOOL = "start_app_preview";
const DATA_MODEL_LABEL = "Preparing the app's data model";
const APP_VALIDATION_LABEL = "Validating the app changes";
const HOSTED_RUNTIME_TOOL = "prepare-app-hosted-runtime";
const visibleOperations = new Map([
  ["apply_app_creation", "Building the app in its private workspace"],
  ["compile-app-schema-release", DATA_MODEL_LABEL],
  ["install-app-integrations", "Installing the app's requested integrations"],
  ["prepare-app-local-preview", "Preparing the app's local preview dependencies"],
  [HOSTED_RUNTIME_TOOL, "Setting up your app’s data"],
  ["cleanup-app-hosted-runtime", "Removing the app's Preview resources"],
  ["export-app-hosted-data", "Exporting approved app data privately"],
  ["run-app-continuity-tests", "Checking that the app stays connected after restart"],
  ["run-app-browser-tests", "Running the app's browser tests"],
  [PREVIEW_START_TOOL, "Starting the app preview"],
  ["validate_app_creation", APP_VALIDATION_LABEL],
  ["validate-app-creation", APP_VALIDATION_LABEL],
  ["validate_github_draft_pr_reconciliation", "Checking changes proposed for the draft PR"],
  ["reconcile_github_draft_pr", "Updating the draft pull request"],
]);
const visibleOperationLabels = new Set([
  ...visibleOperations.values(),
  "Preparing the app's dependencies",
  "Preparing the app's data model",
  "Checking the app's data model",
  "Running app tests",
  "Checking the app's workflow",
  "Preparing local app data",
]);
const PREPARING_DATA_MODEL = DATA_MODEL_LABEL;
const ASSISTANT_MESSAGE = "assistant.message";
const INPUT_REQUESTED = "input.requested";
const INPUT_RESOLVED = "input.resolved";
const AUTHORIZATION_REQUIRED = "authorization.required";
const AUTHORIZATION_COMPLETED = "authorization.completed";
const PROTOTYPE_MEDIA_TYPE = "text/html" as const;

const draftValidationCommandSchema = z.string();
const draftValidationCommandLabel = (
  value: z.input<typeof draftValidationCommandSchema>,
): string | undefined => {
  const parsedValue = draftValidationCommandSchema.safeParse(value);
  if (!parsedValue.success) {
    return undefined;
  }
  const command: string = parsedValue.data;
  if (/^mise exec (?:--no-deps )?-- bun install --frozen-lockfile$/u.test(command)) {
    return "Preparing the app's dependencies";
  }
  if (/^mise run (?:--no-deps )?app:compile [a-z][a-z0-9-]*$/u.test(command)) {
    return PREPARING_DATA_MODEL;
  }
  if (
    /^mise run (?:--no-deps )?--skip-tools schema:release -- compile --app [a-z][a-z0-9-]*$/u.test(
      command,
    )
  ) {
    return PREPARING_DATA_MODEL;
  }
  if (/^mise run (?:--no-deps )?--skip-tools app:check [a-z][a-z0-9-]*$/u.test(command)) {
    return "Checking the app's data model";
  }
  if (
    /^mise run (?:--no-deps )?--skip-tools app:test [a-z][a-z0-9-]* [1-9][0-9]*\/[1-9][0-9]*$/u.test(
      command,
    )
  ) {
    return "Running app tests";
  }
  if (/^mise run (?:--no-deps )?--skip-tools \/\/apps\/[a-z][a-z0-9-]*:test-e2e$/u.test(command)) {
    return "Checking the app's workflow";
  }
  const local =
    /mise run (?:--no-deps )?(?:app:local -- |app:runtime prepare )(?<appId>[a-z][a-z0-9-]*)(?: setup| local)/u.exec(
      command,
    );
  return local?.groups?.appId === undefined ? undefined : "Preparing local app data";
};

const recordStringField = (
  value: z.input<z.ZodRecord<z.ZodString, z.ZodString>>,
  key: string,
): string | undefined => {
  const parsedValue = z.record(z.string(), z.string()).safeParse(value);
  return parsedValue.success ? parsedValue.data[key] : undefined;
};

const draftValidationLabelInputSchema = z.record(z.string(), z.string());
const draftValidationLabel = (
  toolName: string,
  value: z.input<typeof draftValidationLabelInputSchema>,
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
  for (const event of events) {
    if (event.type === "status" && ["cancelled", "completed", "failed"].includes(event.status)) {
      pending.clear();
    } else if (event.type === "progress" && visibleOperationLabels.has(event.label)) {
      if (event.state === "started") {
        pending.add(event.label);
      } else if (event.state === "failed") {
        // A failed tool result may omit its command. The generic failure closes the active command.
        pending.clear();
      } else {
        pending.delete(event.label);
      }
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
    "publish-github-draft-pr": "draft pull request publication",
    publish_github_draft_pr: "draft pull request publication",
    reconcile_github_draft_pr: "draft pull request update",
    start_app_preview: "the app preview",
    "validate-app-creation": "app validation",
    validate_app_creation: "app validation",
    validate_github_draft_pr_reconciliation: "draft pull request checks",
  } as const satisfies Record<string, string>;
  const name =
    Object.entries(operationLabels).find(([key]) => key === operation)?.[1] ?? "this Builder step";
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
    mediaType: z.literal(PROTOTYPE_MEDIA_TYPE),
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
  mediaType: z.literal(PROTOTYPE_MEDIA_TYPE),
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
    mediaType: z.literal(PROTOTYPE_MEDIA_TYPE),
    path: z.string().regex(prototypePathPattern),
    recordedByCallId: z.string().min(1),
    revision: lowercaseSha256Schema,
    sessionId: z.string().min(1),
    version: z.literal(2),
  })
  .loose();

interface ReferenceEvent {
  type: string;
  data: unknown;
}
const referenceEventSchema = z.object({ data: z.unknown(), type: z.string() }).loose();
const referenceActionsSchema = z.object({ actions: z.array(z.unknown()) }).loose();
const referenceActionSchema = z
  .object({
    callId: z.string(),
    input: z.unknown(),
    kind: z.string(),
    toolName: z.string(),
  })
  .loose();
const referenceReceiptSchema = z
  .object({
    result: z
      .object({
        callId: z.string(),
        isError: z.boolean().optional(),
        kind: z.literal("tool-result"),
        output: z.unknown(),
        toolName: z.enum(["record_prototype_artifact", "record_ui_preview"]),
      })
      .loose(),
    status: z.literal("completed"),
  })
  .loose();

const appendReferenceRequest = (
  candidateAction: z.infer<typeof referenceActionSchema>,
  requested: Map<string, z.infer<typeof prototypeRequestSchema>>,
  requestedUiPreview: Map<string, string>,
): void => {
  if (candidateAction.kind !== "tool-call") {
    return;
  }
  const { callId, input, toolName } = candidateAction;
  if (toolName === "record_prototype_artifact") {
    requestedUiPreview.delete(callId);
    const request = prototypeRequestSchema.safeParse(input);
    if (request.success) {
      requested.set(callId, request.data);
    } else {
      requested.delete(callId);
    }
    return;
  }
  requested.delete(callId);
  if (toolName === "record_ui_preview") {
    const preview = z
      .object({ appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u) })
      .loose()
      .safeParse(input);
    if (preview.success) {
      requestedUiPreview.set(callId, preview.data.appId);
    } else {
      requestedUiPreview.delete(callId);
    }
  } else {
    requestedUiPreview.delete(callId);
  }
};

const referencePreviewMatches = (
  value: {
    appId: string;
    path: string;
    sessionId: string;
    recordedByCallId: string;
    digest: string;
    artifactDigest: string;
    artifactRevision: string;
    mediaType: PROTOTYPE_MEDIA_TYPE;
  },
  appId: string,
  sessionId: string,
  callId: string,
): boolean => {
  if (value.appId !== appId || value.path !== `prototype/${appId}/index.html`) {
    return false;
  }
  if (value.sessionId !== sessionId || value.recordedByCallId !== callId) {
    return false;
  }
  if (value.digest !== value.artifactDigest) {
    return false;
  }
  return (
    value.artifactRevision ===
    sha256(JSON.stringify({ digest: value.digest, mediaType: value.mediaType, path: value.path }))
  );
};

const referenceRequestMatches = (
  value: z.infer<typeof prototypeReferenceResultSchema>,
  request: z.infer<typeof prototypeRequestSchema>,
  sessionId: string,
  callId: string,
): boolean => {
  const appId = prototypePathPattern.exec(request.path)?.groups?.appId;
  const revision = sha256(
    JSON.stringify({ digest: value.digest, mediaType: value.mediaType, path: value.path }),
  );
  if (value.sessionId !== sessionId || value.recordedByCallId !== callId || value.appId !== appId) {
    return false;
  }
  if (
    value.path !== request.path ||
    value.mediaType !== request.mediaType ||
    value.revision !== revision
  ) {
    return false;
  }
  if (request.expectedDigest !== undefined && value.digest !== request.expectedDigest) {
    return false;
  }
  if (
    request.chunkIndex !== undefined &&
    (request.finalChunk !== true || value.chunkCount !== request.chunkIndex + 1)
  ) {
    return false;
  }
  return (
    request.chunkIndex !== undefined ||
    (value.digest === sha256(request.content) &&
      value.contentBytes === Buffer.byteLength(request.content, "utf-8"))
  );
};

const projectReferencePreviewReceipt = (
  receipt: z.infer<typeof referenceReceiptSchema>["result"],
  appId: string | undefined,
  sessionId: string,
): PublicPrototypeReference | undefined => {
  if (appId === undefined || receipt.isError === true) {
    return undefined;
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
      mediaType: z.literal(PROTOTYPE_MEDIA_TYPE),
      path: z.string().regex(prototypePathPattern),
      recordedByCallId: z.string(),
      sessionId: z.string(),
      version: z.literal(2),
    })
    .loose()
    .safeParse(receipt.output);
  if (!output.success || !referencePreviewMatches(output.data, appId, sessionId, receipt.callId)) {
    return undefined;
  }
  const value = output.data;
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
  return projected.success ? projected.data : undefined;
};

const projectReferenceArtifactReceipt = (
  receipt: z.infer<typeof referenceReceiptSchema>["result"],
  request: z.infer<typeof prototypeRequestSchema> | undefined,
  sessionId: string,
): PublicPrototypeReference | undefined => {
  if (request === undefined || receipt.isError === true) {
    return undefined;
  }
  const output = prototypeReferenceResultSchema.safeParse(receipt.output);
  if (
    !output.success ||
    !referenceRequestMatches(output.data, request, sessionId, receipt.callId)
  ) {
    return undefined;
  }
  const value = output.data;
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
  return projected.success ? projected.data : undefined;
};

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
        mediaType: z.literal(PROTOTYPE_MEDIA_TYPE),
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
    accept(candidate: ReferenceEvent) {
      const event = referenceEventSchema.safeParse(candidate);
      if (!event.success) {
        return;
      }
      if (event.data.type === "actions.requested") {
        acceptReferenceActions(event.data.data, requested, requestedUiPreview);
        return;
      }
      if (event.data.type !== "action.result") {
        return;
      }
      const parsedReceipt = referenceReceiptSchema.safeParse(event.data.data);
      if (!parsedReceipt.success) {
        return;
      }
      const receipt = parsedReceipt.data.result;
      if (receipt.toolName === "record_ui_preview") {
        const appId = requestedUiPreview.get(receipt.callId);
        requestedUiPreview.delete(receipt.callId);
        latest = projectReferencePreviewReceipt(receipt, appId, input.sessionId) ?? latest;
        return;
      }
      const request = requested.get(receipt.callId);
      requested.delete(receipt.callId);
      latest = projectReferenceArtifactReceipt(receipt, request, input.sessionId) ?? latest;
    },
    checkpoint: (): InstalledPrototypeReferenceState =>
      installedPrototypeReferenceStateSchema.parse(
        (() => {
          const checkpoint: InstalledPrototypeReferenceState = {
            requested: [...requested],
            requestedUiPreview: [...requestedUiPreview],
          };
          if (latest !== undefined) {
            checkpoint.latest = latest;
          }
          return checkpoint;
        })(),
      ),
    snapshot: () => latest,
  };
};

const acceptReferenceActions = (
  data: unknown,
  requested: Map<string, z.infer<typeof prototypeRequestSchema>>,
  requestedUiPreview: Map<string, string>,
): void => {
  const actions = referenceActionsSchema.safeParse(data);
  if (!actions.success) {
    return;
  }
  for (const candidate of actions.data.actions) {
    const parsed = referenceActionSchema.safeParse(candidate);
    if (parsed.success) {
      appendReferenceRequest(parsed.data, requested, requestedUiPreview);
    }
  }
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

const prototypeArtifactOutputSchema = z.object({
  byteOffset: z.number().int().nonnegative().optional(),
  chunkDigest: lowercaseSha256Schema.optional(),
  complete: z.boolean().optional(),
  content: z.string().min(1),
  digest: lowercaseSha256Schema,
  mediaType: z.literal(PROTOTYPE_MEDIA_TYPE),
  nextOffsetBytes: z.number().int().nonnegative().optional(),
  path: z.string().regex(prototypePathPattern),
  revision: lowercaseSha256Schema,
  totalBytes: z.number().int().positive().optional(),
});

type ArtifactReadRequest = z.infer<
  typeof installedPrototypeProjectorStateSchema
>["artifactReadRequests"][number][1];
type PrototypeArtifactOutput = z.infer<typeof prototypeArtifactOutputSchema>;
const artifactReadMatches = (
  input: ArtifactReadRequest,
  output: PrototypeArtifactOutput,
): boolean =>
  input.path === output.path &&
  input.digest === output.digest &&
  (input.revision === undefined || input.revision === output.revision);
const artifactChunkMatches = (
  input: ArtifactReadRequest,
  output: PrototypeArtifactOutput,
  byteOffset: number,
  nextOffsetBytes: number,
  chunkDigest: string,
): boolean =>
  input.offsetBytes === byteOffset &&
  sha256(output.content) === chunkDigest &&
  Buffer.byteLength(output.content, "utf-8") === nextOffsetBytes - byteOffset;
const readChunkContinues = (
  prior: PrototypeReadChunks,
  input: ArtifactReadRequest,
  output: PrototypeArtifactOutput,
  byteOffset: number,
  totalBytes: number,
): boolean =>
  [
    prior.nextOffsetBytes === byteOffset,
    prior.totalBytes === totalBytes,
    prior.digest === output.digest,
    prior.revision === output.revision,
    input.revision === prior.revision,
  ].every(Boolean);
const assembledPreviewMatches = (
  content: string,
  assembled: PrototypeReadChunks,
  expected: { path: string; digest: string; revision: string } | undefined,
): boolean =>
  sha256(content) === assembled.digest &&
  (expected === undefined ||
    [
      expected.path === assembled.path,
      expected.digest === assembled.digest,
      expected.revision === assembled.revision,
    ].every(Boolean));
type PrototypeResult = z.infer<typeof prototypeResultSchema>;
type PrototypeRequest = z.infer<typeof prototypeRequestSchema>;
type PrototypeTransferInput = PrototypeRequest & { chunkIndex: number; expectedDigest: string };
const completeChunkMatches = (
  input: PrototypeRequest,
  output: PrototypeResult,
  appId: string | undefined,
  callId: string,
  chunkDigest: string,
): boolean =>
  [
    input.expectedDigest === chunkDigest,
    output.complete === true,
    output.digest === chunkDigest,
    output.appId === appId,
    output.path === input.path,
    output.mediaType === input.mediaType,
    output.size === Buffer.byteLength(input.content, "utf-8"),
    output.recordedByCallId === callId,
  ].every(Boolean);
const recordedChunkMatches = (
  output: PrototypeResult,
  input: PrototypeTransferInput,
  appId: string | undefined,
  callId: string,
  revision: string,
  receivedBytes: number,
): boolean =>
  [
    output.revision === revision,
    output.appId === appId,
    output.path === input.path,
    output.mediaType === input.mediaType,
    output.size === receivedBytes,
    output.recordedByCallId === callId,
  ].every(Boolean);
const continuedChunkMatches = (
  output: PrototypeResult,
  input: PrototypeRequest,
  appId: string | undefined,
  callId: string,
  digest: string,
  receivedBytes: number,
): boolean =>
  [
    output.appId === appId,
    output.path === input.path,
    output.mediaType === input.mediaType,
    output.digest === digest,
    output.size === receivedBytes,
    output.recordedByCallId === callId,
  ].every(Boolean);

const observeActionsRequested = (
  actions: readonly unknown[],
  requested: Map<string, PrototypeRequest>,
  artifactReadRequests: Map<string, ArtifactReadRequest>,
): void => {
  for (const action of actions) {
    if (
      typeof action !== "object" ||
      action === null ||
      !("kind" in action) ||
      action.kind !== "tool-call"
    ) {
      continue;
    }
    const parsedAction = z
      .object({ callId: z.string(), input: z.unknown(), toolName: z.string() })
      .safeParse(action);
    if (!parsedAction.success) {
      continue;
    }
    const { callId, input, toolName } = parsedAction.data;
    if (toolName === "record_prototype_artifact") {
      const parsed = prototypeRequestSchema.safeParse(input);
      if (parsed.success) {
        requested.set(callId, parsed.data);
      } else {
        requested.delete(callId);
      }
    } else {
      requested.delete(callId);
    }
    if (toolName === "get_prototype_artifact") {
      const parsed = artifactReadRequestSchema.safeParse(input);
      if (parsed.success) {
        artifactReadRequests.set(callId, parsed.data);
      } else {
        artifactReadRequests.delete(callId);
      }
    } else {
      artifactReadRequests.delete(callId);
    }
  }
};

const artifactReadRequestSchema = z.object({
  digest: lowercaseSha256Schema,
  offsetBytes: z.number().int().nonnegative().optional(),
  path: z.string().regex(prototypePathPattern),
  revision: lowercaseSha256Schema.optional(),
});

const observeUiPreview = (
  value: unknown,
  setLatest: (preview: PublicPrototype) => void,
  setExpected: (preview: { path: string; digest: string; revision: string }) => void,
): void => {
  const preview = uiPreviewResultSchema.safeParse(value);
  if (!preview.success || preview.data.complete === false) {
    return;
  }
  const { content } = preview.data;
  if (content !== undefined) {
    if (sha256(content) !== preview.data.digest) {
      return;
    }
    setLatest(
      publicPrototypeSchema.parse({
        content,
        digest: preview.data.digest,
        mediaType: PROTOTYPE_MEDIA_TYPE,
        path: `prototype/${preview.data.appId}/index.html`,
        revision: preview.data.artifactRevision ?? preview.data.digest,
      }),
    );
    return;
  }
  if (
    preview.data.requiresChunkedRead &&
    preview.data.artifactDigest &&
    preview.data.artifactRevision
  ) {
    setExpected({
      digest: preview.data.artifactDigest,
      path: `prototype/${preview.data.appId}/index.html`,
      revision: preview.data.artifactRevision,
    });
  }
};

const observeArtifactRead = (
  callId: string,
  value: unknown,
  input: ArtifactReadRequest | undefined,
  chunks: Map<string, PrototypeReadChunks>,
  expected: { path: string; digest: string; revision: string } | undefined,
  setLatest: (preview: PublicPrototype) => void,
): void => {
  const output = prototypeArtifactOutputSchema.safeParse(value);
  if (input === undefined || !output.success || !artifactReadMatches(input, output.data)) {
    return;
  }
  const artifact = output.data;
  if (artifact.byteOffset === undefined) {
    if (sha256(artifact.content) === artifact.digest) {
      setLatest(publicPrototypeSchema.parse({ ...artifact, mediaType: PROTOTYPE_MEDIA_TYPE }));
    }
    return;
  }
  const { byteOffset, nextOffsetBytes, totalBytes, chunkDigest } = artifact;
  if (
    nextOffsetBytes === undefined ||
    totalBytes === undefined ||
    chunkDigest === undefined ||
    !artifactChunkMatches(input, artifact, byteOffset, nextOffsetBytes, chunkDigest)
  ) {
    chunks.delete(artifact.path);
    return;
  }
  const prior = chunks.get(artifact.path);
  if (byteOffset === 0 && input.revision !== undefined) {
    chunks.set(artifact.path, {
      chunks: [artifact.content],
      digest: artifact.digest,
      mediaType: PROTOTYPE_MEDIA_TYPE,
      nextOffsetBytes,
      path: artifact.path,
      revision: artifact.revision,
      totalBytes,
    });
  } else if (
    byteOffset !== 0 &&
    prior !== undefined &&
    readChunkContinues(prior, input, artifact, byteOffset, totalBytes)
  ) {
    chunks.set(artifact.path, {
      ...prior,
      chunks: [...prior.chunks, artifact.content],
      nextOffsetBytes,
    });
  } else {
    chunks.delete(artifact.path);
    return;
  }
  const assembled = chunks.get(artifact.path);
  if (artifact.complete === true && assembled?.nextOffsetBytes === totalBytes) {
    const content = assembled.chunks.join("");
    if (assembledPreviewMatches(content, assembled, expected)) {
      setLatest(
        publicPrototypeSchema.parse({
          content,
          digest: assembled.digest,
          mediaType: PROTOTYPE_MEDIA_TYPE,
          path: assembled.path,
          revision: assembled.revision,
        }),
      );
    }
    chunks.delete(artifact.path);
  }
};

const observePrototypeReceipt = (
  callId: string,
  value: unknown,
  input: PrototypeRequest | undefined,
  transfers: Map<string, PrototypeTransfer>,
  setLatest: (preview: PublicPrototype) => void,
): void => {
  const output = prototypeResultSchema.safeParse(value);
  if (input === undefined || !output.success) {
    return;
  }
  const result = output.data;
  const appId = prototypePathPattern.exec(input.path)?.groups?.appId;
  if (input.chunkIndex !== undefined && input.expectedDigest !== undefined) {
    observePrototypeChunk(callId, input, result, appId, transfers, setLatest);
    return;
  }
  const digest = sha256(input.content);
  const revision = sha256(JSON.stringify({ digest, mediaType: input.mediaType, path: input.path }));
  const size = Buffer.byteLength(input.content, "utf-8");
  if (
    ![
      result.appId === appId,
      result.path === input.path,
      result.mediaType === input.mediaType,
      result.digest === digest,
      result.revision === revision,
      result.size === size,
      result.recordedByCallId === callId,
    ].every(Boolean)
  ) {
    return;
  }
  setLatest(
    publicPrototypeSchema.parse({
      content: input.content,
      digest,
      mediaType: input.mediaType,
      path: input.path,
      revision,
    }),
  );
};

const observePrototypeChunk = (
  callId: string,
  input: PrototypeRequest,
  output: PrototypeResult,
  appId: string | undefined,
  transfers: Map<string, PrototypeTransfer>,
  setLatest: (preview: PublicPrototype) => void,
): void => {
  const prior = transfers.get(input.path);
  const chunkDigest = sha256(input.content);
  const fail = (): void => {
    transfers.delete(input.path);
  };
  if (input.chunkIndex === 0) {
    if (completeChunkMatches(input, output, appId, callId, chunkDigest)) {
      const revision = sha256(
        JSON.stringify({ digest: chunkDigest, mediaType: input.mediaType, path: input.path }),
      );
      if (output.revision === revision) {
        transfers.delete(input.path);
        setLatest(
          publicPrototypeSchema.parse({
            content: input.content,
            digest: chunkDigest,
            mediaType: input.mediaType,
            path: input.path,
            revision,
          }),
        );
      }
      return;
    }
    const rollingDigest = sha256(chunkDigest);
    const receivedBytes = Buffer.byteLength(input.content, "utf-8");
    if (
      output.digest !== rollingDigest ||
      output.nextChunkIndex !== 1 ||
      output.complete !== false
    ) {
      fail();
      return;
    }
    const transferInput: PrototypeTransferInput = {
      ...input,
      chunkIndex: 0,
      expectedDigest: input.expectedDigest,
    };
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
    if (!recordedChunkMatches(output, transferInput, appId, callId, revision, receivedBytes)) {
      fail();
      return;
    }
    transfers.set(input.path, { ...transfer, revision });
    return;
  }
  if (prior === undefined || prior.expectedDigest !== input.expectedDigest) {
    fail();
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
    output.nextChunkIndex !== input.chunkIndex + 1
  ) {
    fail();
    return;
  }
  const chunks = [...prior.chunks, input.content];
  const receivedBytes = prior.receivedBytes + Buffer.byteLength(input.content, "utf-8");
  const rollingDigest = sha256(`${prior.rollingDigest}${chunkDigest}`);
  const complete = input.finalChunk === true;
  const transferInput: PrototypeTransferInput = {
    ...input,
    chunkIndex: input.chunkIndex,
    expectedDigest: input.expectedDigest,
  };
  const resultingDigest = complete ? input.expectedDigest : rollingDigest;
  if (
    !continuedChunkMatches(output, input, appId, callId, resultingDigest, receivedBytes) ||
    output.complete !== complete
  ) {
    fail();
    return;
  }
  const assembled = complete ? chunks.join("") : null;
  const digest = assembled === null ? rollingDigest : sha256(assembled);
  if (complete && digest !== input.expectedDigest) {
    fail();
    return;
  }
  const transfer = {
    chunks,
    expectedDigest: input.expectedDigest,
    lastCallId: callId,
    lastChunkDigest: chunkDigest,
    lastChunkIndex: input.chunkIndex,
    nextChunkIndex: input.chunkIndex + 1,
    receivedBytes,
    rollingDigest,
  };
  const revision = complete
    ? sha256(JSON.stringify({ digest, mediaType: input.mediaType, path: input.path }))
    : sha256(
        JSON.stringify({
          digest: rollingDigest,
          mediaType: input.mediaType,
          path: input.path,
          transfer,
        }),
      );
  if (output.revision !== revision) {
    fail();
    return;
  }
  if (assembled === null) {
    transfers.set(input.path, { ...transfer, revision });
  } else {
    transfers.delete(input.path);
    setLatest(
      publicPrototypeSchema.parse({
        content: assembled,
        digest,
        mediaType: input.mediaType,
        path: input.path,
        revision,
      }),
    );
  }
};

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

interface PrototypeTransfer {
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
interface PrototypeReadChunks {
  chunks: string[];
  nextOffsetBytes: number;
  totalBytes: number;
  mediaType: PROTOTYPE_MEDIA_TYPE;
  path: string;
  digest: string;
  revision: string;
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
  const readChunks = new Map<string, PrototypeReadChunks>(state?.readChunks);
  let expectedChunkedPreview: { path: string; digest: string; revision: string } | undefined =
    state?.expectedChunkedPreview;
  const transfers = new Map<string, PrototypeTransfer>(state?.transfers);
  let latest: PublicPrototype | undefined = state?.latest;
  const setLatest = (preview: PublicPrototype): void => {
    latest = preview;
  };

  const observe = (event: MessageStreamEvent): void => {
    if (event.type === "actions.requested") {
      observeActionsRequested(event.data.actions, requested, artifactReadRequests);
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

    const { callId, output, toolName } = event.data.result;
    if (toolName === "record_ui_preview") {
      observeUiPreview(output, setLatest, (value) => {
        expectedChunkedPreview = value;
      });
      return;
    }
    if (toolName === "get_prototype_artifact") {
      observeArtifactRead(
        callId,
        output,
        artifactReadRequests.get(callId),
        readChunks,
        expectedChunkedPreview,
        setLatest,
      );
      return;
    }
    if (toolName === "record_prototype_artifact") {
      observePrototypeReceipt(callId, output, requested.get(callId), transfers, setLatest);
    }
  };

  return {
    checkpoint: () =>
      installedPrototypeProjectorStateSchema.parse(
        (() => {
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
          return checkpoint;
        })(),
      ),
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
    const previewContent = preview.success ? preview.data.content : undefined;
    if (
      !preview.success ||
      preview.data.complete === false ||
      (previewContent !== undefined && sha256(previewContent) !== preview.data.digest) ||
      (previewContent === undefined && preview.data.requiresChunkedRead !== true)
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
  receipt !== null && receipt !== undefined && Date.parse(receipt.expiresAt) <= nowMs
    ? null
    : receipt;

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
          (action) => action.kind === "tool-call" && action.toolName === PREVIEW_START_TOOL,
        )
      ) {
        latest = null;
      }
      continue;
    }
    if (
      event.type !== "action.result" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== PREVIEW_START_TOOL
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
      const snapshot: {
        uiPreview?: PublicUiPreview;
        workingPreview?: PublicWorkingPreview | null;
      } = {};
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
    "publish-github-draft-pr": "Publish the reviewed changes?",
    publish_github_draft_pr: "Publish the reviewed changes?",
    reconcile_github_draft_pr: "Update the draft pull request?",
    "run-app-continuity-tests": "Run this app continuity suite?",
    update_github_draft_pr: "Update the draft pull request?",
  } as const;
  const toolName = request.action?.toolName;
  if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    silentInternalApprovalTools.has(toolName)
  ) {
    return undefined;
  }
  const knownApprovalTitle = (name: string | undefined): string | undefined => {
    if (name === undefined) {
      return undefined;
    }
    return Object.hasOwn(approvalTitles, name)
      ? approvalTitles[name as keyof typeof approvalTitles]
      : undefined;
  };
  const title =
    request.kind === "tool-approval"
      ? (knownApprovalTitle(toolName) ?? request.prompt)
      : request.prompt;
  let description: string | undefined;
  if (request.kind === "tool-approval" && toolName === "apply_app_creation") {
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
  const projected: PublicInputRequest = {
    allowFreeform: request.allowFreeform ?? false,
    kind: request.kind === "tool-approval" ? "approval" : "question",
    requestId: request.requestId,
    title,
  };
  if (description !== undefined) {
    projected.description = description;
  }
  if (request.options !== undefined) {
    projected.options = request.options.map(({ id, label }) => ({ id, label }));
  }
  return projected;
};

const hostedIdentityInvitationSchema = z.object({
  authIdentityLink: z.url().startsWith("https://"),
});
type HostedIdentityInvitation = z.infer<typeof hostedIdentityInvitationSchema>;

/** Only the ordinary invitation is public; the rest of a suspended tool result stays private. */
const hostedIdentityInvitation = (invitation: HostedIdentityInvitation): string | undefined => {
  const url = new URL(invitation.authIdentityLink);
  if (url.username !== "" || url.password !== "" || /[\r\n<>]/u.test(url.href)) {
    return undefined;
  }
  return `Sign in to connect your account: <${url.href}>. The approved preparation resumes automatically.`;
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
              type: ASSISTANT_MESSAGE,
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
        const label = draftValidationLabel(action.toolName, action.input, true);
        return label === undefined ? [] : [{ index, label, state: "started", type: "progress" }];
      });
    }
    case "action.partial": {
      const { result, turnId, sequence } = event.data;
      if (
        result.kind !== "tool-result" ||
        result.toolName !== "prepare-app-hosted-runtime" ||
        result.isError === true
      ) {
        return [];
      }
      const invitationInput = hostedIdentityInvitationSchema.safeParse(result.output);
      if (!invitationInput.success) {
        return [];
      }
      const text = hostedIdentityInvitation(invitationInput.data);
      const invitation = publicIdentityInvitationSchema.safeParse({
        callId: result.callId,
        expiresAt: recordStringField(result.output, "authIdentityLinkExpiresAt"),
        url: recordStringField(result.output, "authIdentityLink"),
      });
      return [
        {
          index,
          text,
          // Keep a yielded invitation distinct from the later model reply, stable on replay.
          turnId: `${turnId}:identity-invitation:${result.callId}:${sequence}`,
          type: ASSISTANT_MESSAGE,
        },
        ...(invitation.success
          ? [{ identityInvitation: invitation.data, index, type: "auth_identity_invitation" }]
          : []),
      ];
    }
    case "action.result": {
      if (event.data.result?.kind !== "tool-result") {
        return [];
      }
      const label = draftValidationLabel(
        event.data.result.toolName,
        event.data.result.output,
        false,
      );
      const returnedStatus = recordStringField(event.data.result.output, "status");
      const commandFailed =
        (event.data.result.toolName === "prepare-app-hosted-runtime" &&
          returnedStatus === "blocked") ||
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
      return event.data.result.toolName === "prepare-app-hosted-runtime"
        ? [
            ...progress,
            { callId: event.data.result.callId, index, type: "auth_identity_invitation_resolved" },
          ]
        : progress;
    }
    case INPUT_REQUESTED: {
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
        : projectedRequests.map((request, requestIndex) => {
            const projected: InternalEveEvent = { index, request, type: INPUT_REQUESTED };
            if (isFrameworkSessionLimitInput(event.data.requests[requestIndex])) {
              projected.frameworkSessionLimit = true;
            }
            return projected;
          });
    }
    case INPUT_RESOLVED: {
      return [
        {
          index,
          requestIds: event.data.resolutions.map(({ requestId }) => requestId),
          type: INPUT_RESOLVED,
        },
      ];
    }
    case "approval.settled": {
      return [
        {
          index,
          requestIds: [event.data.requestId],
          type: INPUT_RESOLVED,
        },
      ];
    }
    case AUTHORIZATION_REQUIRED: {
      const requestId = authorizationRequestId(event.data);
      if (requestId === undefined) {
        return [];
      }
      const { authorization } = event.data;
      const authorizationRecord = z.record(z.string(), z.string()).safeParse(authorization);
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
            requestId,
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
          type: INPUT_REQUESTED,
        },
      ];
    }
    case AUTHORIZATION_COMPLETED: {
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
              type: INPUT_RESOLVED,
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
    if (event.type === AUTHORIZATION_REQUIRED || event.type === AUTHORIZATION_COMPLETED) {
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
    if (event.type === INPUT_REQUESTED) {
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
    if (event.type === INPUT_RESOLVED) {
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
    if (event.type === INPUT_REQUESTED && event.request !== undefined) {
      outstanding.set(event.request.requestId, event.request);
    }
    if (event.type === INPUT_RESOLVED) {
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
    if (event.type === INPUT_REQUESTED) {
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
    if (event.type === INPUT_RESOLVED) {
      for (const resolution of event.data.resolutions) {
        outstanding.delete(resolution.requestId);
      }
    }
    if (event.type === "approval.settled") {
      outstanding.delete(event.data.requestId);
    }
    if (event.type === AUTHORIZATION_REQUIRED || event.type === AUTHORIZATION_COMPLETED) {
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
    case "auth_identity_invitation": {
      const invitation = publicIdentityInvitationSchema.safeParse(event.identityInvitation);
      return invitation.success
        ? { ...invitation.data, index: event.index, type: "auth_identity_invitation" }
        : null;
    }
    case "auth_identity_invitation_resolved": {
      return event.callId !== undefined && event.callId !== ""
        ? { callId: event.callId, index: event.index, type: "auth_identity_invitation_resolved" }
        : null;
    }
    case ASSISTANT_MESSAGE: {
      return event.turnId !== undefined && event.turnId !== "" && event.text !== undefined
        ? {
            index: event.index,
            text: event.text,
            turnId: event.turnId,
            type: "assistant_message",
          }
        : null;
    }
    case "progress": {
      const state = z.enum(["started", "completed", "failed"]).safeParse(event.state);
      if (event.label === undefined || event.label === "" || !state.success) {
        return null;
      }
      const projected: Extract<PublicEveEvent, { type: "progress" }> = {
        index: event.index,
        label: event.label,
        state: state.data,
        type: "progress",
      };
      if (event.turnId !== undefined) {
        projected.turnId = event.turnId;
      }
      return projected;
    }
    case INPUT_REQUESTED: {
      return event.request && event.frameworkSessionLimit !== true
        ? { index: event.index, request: event.request, type: "input_required" }
        : null;
    }
    case "status": {
      return event.status === undefined
        ? null
        : { index: event.index, status: event.status, type: "status" };
    }
    case "error.public": {
      if (
        event.code === undefined ||
        event.code === "" ||
        event.message === undefined ||
        event.message === ""
      ) {
        return null;
      }
      return { code: event.code, index: event.index, message: event.message, type: "error" };
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
  const result: PublicEveEvent[] = [];
  for (const source of events) {
    if (source.type === "actions.requested") {
      const requested = source.data.actions.filter((action) => action.kind === "tool-call");
      operation = requested.at(-1)?.toolName ?? operation;
    }
    for (const internal of projectInstalledEveEvent(source, 0, operation)) {
      const projected = toPublicEvent(internal);
      if (projected !== null) {
        result.push({ ...projected, index: result.length });
      }
    }
  }
  return result;
};

/** Allowlist an internal event. Unknown, reasoning, and raw tool events are dropped. */
