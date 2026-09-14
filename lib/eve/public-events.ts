import { createHash } from "node:crypto";

import {
  publicImplementationPlanSchema,
  publicPrototypeSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
} from "../mcp/contracts";
import type {
  EveSessionStatus,
  PublicEveEvent,
  PublicImplementationPlan,
  PublicInputRequest,
  PublicPrototype,
  PublicUiPreview,
  PublicWorkingPreview,
} from "../mcp/contracts";
import { targetProposalSchema } from "../repository/target-planning";
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
const silentInternalApprovalTools = new Set([
  "accept_app_spec",
  "validate-app-creation",
  "accept_change_set",
]);
const unavailableConfirmationMessage = "I couldn't verify this action, so it was not run.";
const unavailableContinuationMessage =
  "I couldn't finish preparing your app. Your progress is saved, so you can try again.";
const maximumPrototypeBytes = 8 * 1024 * 1024;
const prototypePathPattern = /^prototype\/(?<appId>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/index\.html$/u;
const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const prefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const immutableExecutionArtifactSchema = z.string().regex(/^(?!fixture@).+@sha256:[a-f0-9]{64}$/u);
const prototypeRequestSchema = z
  .object({
    content: z.string().min(1).max(maximumPrototypeBytes),
    mediaType: z.literal("text/html"),
    path: z.string().regex(prototypePathPattern),
  })
  .strict();
const prototypeResultSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    digest: lowercaseSha256Schema,
    invalidated: z.boolean().optional(),
    mediaType: z.literal("text/html"),
    path: z.string().regex(prototypePathPattern),
    recordedByCallId: z.string().min(1),
    reused: z.boolean(),
    revision: lowercaseSha256Schema,
    sessionId: z.string().min(1),
    size: z.number().int().min(1).max(maximumPrototypeBytes),
  })
  .strict();
const uiPreviewResultSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    content: z.string().min(1).max(maximumPrototypeBytes),
    digest: lowercaseSha256Schema,
    fidelity: z.literal("arrusted-component-catalog"),
    functionality: z.literal("fixtures-only"),
    revision: lowercaseSha256Schema,
    routes: z.array(z.string().startsWith("/")).min(1).max(16),
  })
  .passthrough();
const planRequestSchema = z
  .object({
    existingAppChanges: z
      .array(
        z
          .object({
            content: z.string().max(262_144),
            path: z
              .string()
              .min(1)
              .max(512)
              .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@:-]+$/u),
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .optional(),
    expectedAppSpecDigest: lowercaseSha256Schema,
  })
  .strict();
const planResultSchema = z
  .object({
    appSpecDigest: lowercaseSha256Schema,
    artifactRevision: lowercaseSha256Schema,
    contractDigest: lowercaseSha256Schema,
    dependencyCacheDigest: prefixedSha256Schema,
    digest: lowercaseSha256Schema,
    eligibilityDigest: lowercaseSha256Schema,
    identityDigest: lowercaseSha256Schema,
    imageDigest: immutableExecutionArtifactSchema,
    plannedByCallId: z.string().min(1),
    reused: z.boolean(),
    sourceReceiptDigest: lowercaseSha256Schema,
    sourceSha: gitObjectIdSchema,
    sourceTree: gitObjectIdSchema,
    target: targetProposalSchema,
    version: z.literal(1),
    workspaceDigest: lowercaseSha256Schema,
  })
  .strict();

const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");

const verifiedImplementationPlan = (
  callId: string,
  request: z.infer<typeof planRequestSchema>,
  candidate: unknown,
): PublicImplementationPlan | undefined => {
  const parsed = planResultSchema.safeParse(candidate);
  if (!parsed.success) {return undefined;}
  const result = parsed.data;
  const rawResult = candidate as Record<string, unknown>;
  const rawTarget = rawResult.target;
  if (typeof rawTarget !== "object" || rawTarget === null) {return undefined;}
  const { target } = result;
  const requestedChanges = request.existingAppChanges;
  const iterationMatchesRequest =
    requestedChanges === undefined
      ? !("operation" in target)
      : "operation" in target &&
        target.operation === "iterate-existing-app" &&
        target.iteration.changes.length === requestedChanges.length &&
        target.iteration.changes.every(
          (change, index) =>
            change.path === requestedChanges[index]?.path &&
            change.after.content === requestedChanges[index]?.content,
        );
  if (
    (!result.reused && result.plannedByCallId !== callId) ||
    result.appSpecDigest !== request.expectedAppSpecDigest ||
    target.contract.appSpec.sha256 !== request.expectedAppSpecDigest ||
    target.plan.product.appSpec.sha256 !== request.expectedAppSpecDigest ||
    !iterationMatchesRequest ||
    result.contractDigest !==
      sha256(JSON.stringify((rawTarget as Record<string, unknown>).contract)) ||
    result.digest !==
      sha256(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(rawResult).filter(([key]) => key !== "digest" && key !== "reused"),
          ),
        ),
      ) ||
    target.blockers.length !== 0 ||
    target.mutations.length !== 0
  )
    {return undefined;}
  return publicImplementationPlanSchema.parse({
    appId: target.contract.appId,
    packageName: target.plan.source.packageName,
    projectName: target.plan.topology.projectName,
    readOnly: true,
    routes: target.plan.topology.routes,
    runtime: target.plan.source.runtime,
  });
};

/**
 * Projects a compact product plan only after the installed runtime durably
 * completes its fixed target-planning tool with exact request/result bindings.
 */
export const latestInstalledImplementationPlan = (
  events: readonly MessageStreamEvent[],
): PublicImplementationPlan | undefined => {
  const requested = new Map<string, z.infer<typeof planRequestSchema>>();
  let latest: PublicImplementationPlan | undefined;

  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") {continue;}
        if (action.toolName !== "plan_app_creation") {
          requested.delete(action.callId);
          continue;
        }
        const parsed = planRequestSchema.safeParse(action.input);
        if (parsed.success) {requested.set(action.callId, parsed.data);}
        else {requested.delete(action.callId);}
      }
      continue;
    }

    if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.isError === true
    )
      {continue;}

    if (event.data.result.toolName === "record_prototype_artifact") {
      const { output } = event.data.result;
      if (
        typeof output === "object" &&
        output !== null &&
        "invalidated" in output &&
        output.invalidated === true
      )
        {latest = undefined;}
      continue;
    }
    if (event.data.result.toolName !== "plan_app_creation") {continue;}

    const { callId } = event.data.result;
    const input = requested.get(callId);
    if (input === undefined) {continue;}
    const plan = verifiedImplementationPlan(callId, input, event.data.result.output);
    if (plan !== undefined) {latest = plan;}
  }

  return latest;
};

/**
 * Recovers only a successfully recorded HTML prototype from Eve's durable
 * action stream. Raw tool input is never projected without its matching,
 * completed receipt.
 */
export const latestInstalledPrototype = (
  events: readonly MessageStreamEvent[],
): PublicPrototype | undefined => {
  const requested = new Map<string, z.infer<typeof prototypeRequestSchema>>();
  let latest: PublicPrototype | undefined;

  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") {continue;}
        if (action.toolName !== "record_prototype_artifact") {
          requested.delete(action.callId);
          continue;
        }
        const parsed = prototypeRequestSchema.safeParse(action.input);
        if (parsed.success) {requested.set(action.callId, parsed.data);}
        else {requested.delete(action.callId);}
      }
      continue;
    }

    if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.isError === true
    )
      {continue;}

    if (event.data.result.toolName === "record_ui_preview") {
      const preview = uiPreviewResultSchema.safeParse(event.data.result.output);
      if (!preview.success || sha256(preview.data.content) !== preview.data.digest) {continue;}
      latest = publicPrototypeSchema.parse({
        content: preview.data.content,
        digest: preview.data.digest,
        mediaType: "text/html",
        path: `prototype/${preview.data.appId}/index.html`,
        revision: preview.data.digest,
      });
      continue;
    }
    if (event.data.result.toolName !== "record_prototype_artifact") {continue;}

    const { callId } = event.data.result;
    const input = requested.get(callId);
    const output = prototypeResultSchema.safeParse(event.data.result.output);
    if (input === undefined || !output.success) {continue;}

    const appId = prototypePathPattern.exec(input.path)?.[1];
    const digest = sha256(input.content);
    const revision = sha256(
      JSON.stringify({
        digest,
        mediaType: input.mediaType,
        path: input.path,
      }),
    );
    const size = Buffer.byteLength(input.content, "utf-8");
    if (
      size > maximumPrototypeBytes ||
      output.data.appId !== appId ||
      output.data.path !== input.path ||
      output.data.mediaType !== input.mediaType ||
      output.data.digest !== digest ||
      output.data.revision !== revision ||
      output.data.size !== size ||
      output.data.recordedByCallId !== callId
    )
      {continue;}

    latest = publicPrototypeSchema.parse({
      content: input.content,
      digest,
      mediaType: input.mediaType,
      path: input.path,
      revision,
    });
  }

  return latest;
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
    )
      {continue;}
    const preview = uiPreviewResultSchema.safeParse(event.data.result.output);
    if (!preview.success || sha256(preview.data.content) !== preview.data.digest) {continue;}
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
      )
        latest = null;
      continue;
    }
    if (
      event.type !== "action.result" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== "start_app_preview"
    )
      continue;
    latest = null;
    if (event.data.status !== "completed" || event.data.result.isError === true) continue;
    const output = z
      .object({ workingPreview: publicWorkingPreviewSchema })
      .safeParse(event.data.result.output);
    if (output.success) latest = output.data.workingPreview;
  }
  return currentWorkingPreview(latest);
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
  )
    {return undefined;}
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
  )
    {return undefined;}
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
      if (event.type === "step.started") {state = "started";}
      else if (event.type === "step.completed") {state = "completed";}
      else {state = "failed";}
      return [
        {
          index,
          label: "Agent step",
          state,
          turnId: event.data.turnId,
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
      const repositoryAccess = githubRepositoryAccessSchema.safeParse(
        authorization === undefined ? undefined : Reflect.get(authorization, "repositoryAccess"),
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
    case "session.failed": {
      return [
        {
          code: "unable_to_continue",
          index,
          message: unavailableContinuationMessage,
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
      if (projected.some((request) => request === undefined)) {return [];}
      for (const request of event.data.requests) {
        const publicRequest = inputRequest(request);
        if (publicRequest !== undefined) {outstanding.set(request.requestId, publicRequest);}
      }
    }
    if (event.type === "input.resolved")
      {for (const resolution of event.data.resolutions) {outstanding.delete(resolution.requestId);}}
    if (event.type === "approval.settled") {outstanding.delete(event.data.requestId);}
  }
  return [...outstanding.values()];
};

export const outstandingInternalEveRequests = (
  events: readonly InternalEveEvent[],
): PublicInputRequest[] => {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested" && event.request !== undefined)
      {outstanding.set(event.request.requestId, event.request);}
    if (event.type === "input.resolved")
      {for (const requestId of event.requestIds ?? []) {outstanding.delete(requestId);}}
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
      if (projected.some((request) => request === undefined)) {return "failed";}
      for (const request of projected)
        {if (request !== undefined) {outstanding.add(request.requestId);}}
    }
    if (event.type === "input.resolved")
      {for (const resolution of event.data.resolutions) {outstanding.delete(resolution.requestId);}}
    if (event.type === "approval.settled") {outstanding.delete(event.data.requestId);}
    if (event.type === "turn.cancelled") {boundary = "cancelled";}
    if (event.type === "session.waiting") {boundary = "waiting";}
    if (event.type === "session.completed") {boundary = "completed";}
    if (event.type === "session.failed") {boundary = "failed";}
    if (event.type === "step.started") {boundary = "working";}
  }
  if (boundary === "completed" || boundary === "failed") {return boundary;}
  if (outstanding.size > 0) {return "input_required";}
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
): PublicEveEvent[] =>
  events
    .flatMap((event) => projectInstalledEveEvent(event, 0))
    .flatMap((event) => {
      const projected = toPublicEvent(event);
      return projected === null ? [] : [projected];
    })
    .map((event, index) => ({ ...event, index }));

/** Allowlist an internal event. Unknown, reasoning, and raw tool events are dropped. */
