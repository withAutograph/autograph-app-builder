import { createHash } from "node:crypto";

import {
  publicImplementationPlanSchema,
  publicPrototypeSchema,
  type EveSessionStatus,
  type PublicEveEvent,
  type PublicImplementationPlan,
  type PublicInputRequest,
  type PublicPrototype,
} from "../mcp/contracts";
import { targetProposalSchema } from "../repository/target-planning";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { publicApprovalDescription } from "../agent/approval-receipt";

export type InternalEveEvent = {
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
};

const progressStates = new Set(["started", "completed", "failed"]);
const silentInternalApprovalTools = new Set([
  "accept_app_spec",
  "apply_app_creation",
  "validate_app_creation",
  "accept_change_set",
]);
const unavailableConfirmationMessage =
  "I couldn't verify this action, so it was not run.";
const maximumPrototypeBytes = 262_144;
const prototypePathPattern =
  /^prototype\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/index\.html$/u;
const lowercaseSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const prefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const immutableExecutionArtifactSchema = z
  .string()
  .regex(/^(?!fixture@).+@sha256:[a-f0-9]{64}$/u);
const prototypeRequestSchema = z
  .object({
    path: z.string().regex(prototypePathPattern),
    mediaType: z.literal("text/html"),
    content: z.string().min(1).max(maximumPrototypeBytes),
  })
  .strict();
const prototypeResultSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    path: z.string().regex(prototypePathPattern),
    mediaType: z.literal("text/html"),
    digest: lowercaseSha256Schema,
    revision: lowercaseSha256Schema,
    sessionId: z.string().min(1),
    recordedByCallId: z.string().min(1),
    size: z.number().int().min(1).max(maximumPrototypeBytes),
    reused: z.boolean(),
    invalidated: z.boolean().optional(),
  })
  .strict();
const planRequestSchema = z
  .object({ expectedAppSpecDigest: lowercaseSha256Schema })
  .strict();
const planResultSchema = z
  .object({
    version: z.literal(1),
    sourceSha: gitObjectIdSchema,
    sourceTree: gitObjectIdSchema,
    eligibilityDigest: lowercaseSha256Schema,
    workspaceDigest: lowercaseSha256Schema,
    imageDigest: immutableExecutionArtifactSchema,
    dependencyCacheDigest: prefixedSha256Schema,
    appSpecDigest: lowercaseSha256Schema,
    artifactRevision: lowercaseSha256Schema,
    identityDigest: lowercaseSha256Schema,
    contractDigest: lowercaseSha256Schema,
    target: targetProposalSchema,
    plannedByCallId: z.string().min(1),
    digest: lowercaseSha256Schema,
    reused: z.boolean(),
  })
  .strict();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function verifiedImplementationPlan(
  callId: string,
  expectedAppSpecDigest: string,
  candidate: unknown,
): PublicImplementationPlan | undefined {
  const parsed = planResultSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  const target = result.target;
  const unsigned = {
    version: result.version,
    sourceSha: result.sourceSha,
    sourceTree: result.sourceTree,
    eligibilityDigest: result.eligibilityDigest,
    workspaceDigest: result.workspaceDigest,
    imageDigest: result.imageDigest,
    dependencyCacheDigest: result.dependencyCacheDigest,
    appSpecDigest: result.appSpecDigest,
    artifactRevision: result.artifactRevision,
    identityDigest: result.identityDigest,
    contractDigest: result.contractDigest,
    target,
    plannedByCallId: result.plannedByCallId,
  };
  if (
    (!result.reused && result.plannedByCallId !== callId) ||
    result.appSpecDigest !== expectedAppSpecDigest ||
    target.contract.appSpec.sha256 !== expectedAppSpecDigest ||
    target.plan.product.appSpec.sha256 !== expectedAppSpecDigest ||
    result.contractDigest !== sha256(JSON.stringify(target.contract)) ||
    result.digest !== sha256(JSON.stringify(unsigned)) ||
    target.blockers.length !== 0 ||
    target.mutations.length !== 0
  )
    return undefined;
  return publicImplementationPlanSchema.parse({
    appId: target.contract.appId,
    runtime: target.plan.source.runtime,
    workspacePath: target.plan.source.workspacePath,
    packageName: target.plan.source.packageName,
    projectName: target.plan.topology.projectName,
    routes: target.plan.topology.routes,
    sourceSha: result.sourceSha,
    sourceTree: result.sourceTree,
    proposalDigest: result.digest,
    readOnly: true,
  });
}

/**
 * Projects a compact product plan only after the installed runtime durably
 * completes its fixed target-planning tool with exact request/result bindings.
 */
export function latestInstalledImplementationPlan(
  events: readonly MessageStreamEvent[],
): PublicImplementationPlan | undefined {
  const requested = new Map<string, z.infer<typeof planRequestSchema>>();
  let latest: PublicImplementationPlan | undefined;

  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        if (action.toolName !== "plan_app_creation") {
          requested.delete(action.callId);
          continue;
        }
        const parsed = planRequestSchema.safeParse(action.input);
        if (parsed.success) requested.set(action.callId, parsed.data);
        else requested.delete(action.callId);
      }
      continue;
    }

    if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.isError === true
    )
      continue;

    if (event.data.result.toolName === "record_prototype_artifact") {
      const output = event.data.result.output;
      if (
        typeof output === "object" &&
        output !== null &&
        "invalidated" in output &&
        output.invalidated === true
      )
        latest = undefined;
      continue;
    }
    if (event.data.result.toolName !== "plan_app_creation") continue;

    const callId = event.data.result.callId;
    const input = requested.get(callId);
    if (input === undefined) continue;
    const plan = verifiedImplementationPlan(
      callId,
      input.expectedAppSpecDigest,
      event.data.result.output,
    );
    if (plan !== undefined) latest = plan;
  }

  return latest;
}

/**
 * Recovers only a successfully recorded HTML prototype from Eve's durable
 * action stream. Raw tool input is never projected without its matching,
 * completed receipt.
 */
export function latestInstalledPrototype(
  events: readonly MessageStreamEvent[],
): PublicPrototype | undefined {
  const requested = new Map<string, z.infer<typeof prototypeRequestSchema>>();
  let latest: PublicPrototype | undefined;

  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind !== "tool-call") continue;
        if (action.toolName !== "record_prototype_artifact") {
          requested.delete(action.callId);
          continue;
        }
        const parsed = prototypeRequestSchema.safeParse(action.input);
        if (parsed.success) requested.set(action.callId, parsed.data);
        else requested.delete(action.callId);
      }
      continue;
    }

    if (
      event.type !== "action.result" ||
      event.data.status !== "completed" ||
      event.data.result.kind !== "tool-result" ||
      event.data.result.toolName !== "record_prototype_artifact" ||
      event.data.result.isError === true
    )
      continue;

    const callId = event.data.result.callId;
    const input = requested.get(callId);
    const output = prototypeResultSchema.safeParse(event.data.result.output);
    if (input === undefined || !output.success) continue;

    const appId = prototypePathPattern.exec(input.path)?.[1];
    const digest = sha256(input.content);
    const revision = sha256(
      JSON.stringify({
        path: input.path,
        mediaType: input.mediaType,
        digest,
      }),
    );
    const size = Buffer.byteLength(input.content, "utf8");
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
      continue;

    latest = publicPrototypeSchema.parse({
      path: input.path,
      mediaType: input.mediaType,
      content: input.content,
      digest,
      revision,
    });
  }

  return latest;
}

function inputRequest(request: {
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
}): PublicInputRequest | undefined {
  const approvalTitles = {
    publish_github_draft_pr: "Approve draft PR publication",
  } as const;
  const toolName = request.action?.toolName;
  if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    silentInternalApprovalTools.has(toolName)
  )
    return undefined;
  const title =
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles
      ? approvalTitles[toolName as keyof typeof approvalTitles]
      : request.prompt;
  const description =
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles
      ? publicApprovalDescription(request.action?.input, toolName)
      : undefined;
  if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles &&
    description === undefined
  )
    return undefined;
  return {
    requestId: request.requestId,
    kind: request.kind === "tool-approval" ? "approval" : "question",
    title,
    ...(description === undefined ? {} : { description }),
    ...(request.options === undefined
      ? {}
      : { options: request.options.map(({ id, label }) => ({ id, label })) }),
    allowFreeform: request.allowFreeform ?? false,
  };
}

/** Converts only the installed Eve 0.43 events that belong in the public MCP projection. */
export function projectInstalledEveEvent(
  event: MessageStreamEvent,
  index: number,
): InternalEveEvent[] {
  switch (event.type) {
    case "message.completed":
      return event.data.message === null
        ? []
        : [
            {
              type: "assistant.message",
              index,
              turnId: event.data.turnId,
              text: event.data.message,
            },
          ];
    case "step.started":
    case "step.completed":
    case "step.failed":
      return [
        {
          type: "progress",
          index,
          turnId: event.data.turnId,
          label: "Agent step",
          state:
            event.type === "step.started"
              ? "started"
              : event.type === "step.completed"
                ? "completed"
                : "failed",
        },
      ];
    case "input.requested":
      const projectedRequests = event.data.requests.map(inputRequest);
      return projectedRequests.some((request) => request === undefined)
        ? [
            {
              type: "error.public",
              index,
              code: "confirmation_unavailable",
              message: unavailableConfirmationMessage,
            },
            { type: "status", index, status: "failed" },
          ]
        : projectedRequests.map((request) => ({
            type: "input.requested" as const,
            index,
            request,
          }));
    case "input.resolved":
      return [
        {
          type: "input.resolved",
          index,
          requestIds: event.data.resolutions.map(({ requestId }) => requestId),
        },
      ];
    case "approval.settled":
      return [
        {
          type: "input.resolved",
          index,
          requestIds: [event.data.requestId],
        },
      ];
    case "authorization.required":
      const authorization = event.data.authorization;
      return [
        {
          type: "input.requested",
          index,
          request: {
            requestId:
              event.data.attemptId ??
              event.data.candidateId ??
              `${event.data.turnId}:${event.data.name}`,
            kind: "authorization",
            title: event.data.name,
            description: event.data.description,
            ...(authorization === undefined
              ? {}
              : {
                  authorization: {
                    ...(authorization.url === undefined
                      ? {}
                      : { url: authorization.url }),
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
                  },
                }),
            allowFreeform: false,
          },
        },
      ];
    case "turn.cancelled":
      return [{ type: "status", index, status: "cancelled" }];
    case "session.waiting":
      return [{ type: "status", index, status: "waiting" }];
    case "session.completed":
      return [{ type: "status", index, status: "completed" }];
    case "session.failed":
      return [
        {
          type: "error.public",
          index,
          code: event.data.code,
          message: event.data.message,
        },
        { type: "status", index, status: "failed" },
      ];
    default:
      return [];
  }
}

export function outstandingInstalledEveRequests(
  events: readonly MessageStreamEvent[],
): PublicInputRequest[] {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested") {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) return [];
      for (const request of event.data.requests) {
        const publicRequest = inputRequest(request);
        if (publicRequest !== undefined)
          outstanding.set(request.requestId, publicRequest);
      }
    }
    if (event.type === "input.resolved")
      for (const resolution of event.data.resolutions)
        outstanding.delete(resolution.requestId);
    if (event.type === "approval.settled")
      outstanding.delete(event.data.requestId);
  }
  return [...outstanding.values()];
}

export function outstandingInternalEveRequests(
  events: readonly InternalEveEvent[],
): PublicInputRequest[] {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested" && event.request !== undefined)
      outstanding.set(event.request.requestId, event.request);
    if (event.type === "input.resolved")
      for (const requestId of event.requestIds ?? [])
        outstanding.delete(requestId);
  }
  return [...outstanding.values()];
}

export function deriveInstalledEveStatus(
  events: readonly MessageStreamEvent[],
): EveSessionStatus {
  const outstanding = new Set<string>();
  let boundary: EveSessionStatus = "working";
  for (const event of events) {
    if (event.type === "input.requested") {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) return "failed";
      for (const request of projected)
        if (request !== undefined) outstanding.add(request.requestId);
    }
    if (event.type === "input.resolved")
      for (const resolution of event.data.resolutions)
        outstanding.delete(resolution.requestId);
    if (event.type === "approval.settled")
      outstanding.delete(event.data.requestId);
    if (event.type === "turn.cancelled") boundary = "cancelled";
    if (event.type === "session.waiting") boundary = "waiting";
    if (event.type === "session.completed") boundary = "completed";
    if (event.type === "session.failed") boundary = "failed";
    if (event.type === "step.started") boundary = "working";
  }
  if (boundary === "completed" || boundary === "failed") return boundary;
  if (outstanding.size > 0) return "input_required";
  return boundary;
}

/** Project one durable Eve stream into a dense, cursor-addressable public stream. */
export function projectInstalledEveEvents(
  events: readonly MessageStreamEvent[],
): PublicEveEvent[] {
  return events
    .flatMap((event) => projectInstalledEveEvent(event, 0))
    .flatMap((event) => {
      const projected = toPublicEvent(event);
      return projected === null ? [] : [projected];
    })
    .map((event, index) => ({ ...event, index }));
}

/** Allowlist an internal event. Unknown, reasoning, and raw tool events are dropped. */
export function toPublicEvent(event: InternalEveEvent): PublicEveEvent | null {
  switch (event.type) {
    case "assistant.message":
      return event.turnId && event.text !== undefined
        ? {
            type: "assistant_message",
            index: event.index,
            turnId: event.turnId,
            text: event.text,
          }
        : null;
    case "progress":
      return event.label && event.state && progressStates.has(event.state)
        ? {
            type: "progress",
            index: event.index,
            turnId: event.turnId,
            label: event.label,
            state: event.state as "started" | "completed" | "failed",
          }
        : null;
    case "input.requested":
      return event.request
        ? { type: "input_required", index: event.index, request: event.request }
        : null;
    case "status":
      return event.status
        ? { type: "status", index: event.index, status: event.status }
        : null;
    case "error.public":
      return event.code && event.message
        ? {
            type: "error",
            index: event.index,
            code: event.code,
            message: event.message,
          }
        : null;
    default:
      return null;
  }
}
