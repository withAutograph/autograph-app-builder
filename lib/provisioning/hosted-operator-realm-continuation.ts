import type { HostedOperatorCallbackExecution } from "./hosted-operator-callback-owner";
import { createHash } from "node:crypto";
import { z } from "zod";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { RealmContinuationAuthority } from "../hosted/realm-continuation-authority";
import {
  HostedOperatorError,
  operatorPlanDigest,
  hostedOperatorPlanSchema,
} from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";
import type {
  HostedRuntimeIdentityWaitInvocation,
  HostedRuntimeIdentityWaitRegistration,
} from "./hosted-operator-realm-identity-wait";

export const realmContinuationRequestSchema = z.strictObject({
  version: z.literal(1),
  dispatchId: z.string().regex(/^[a-f0-9]{64}$/u),
  authority: z.string().min(1).max(32_768),
});
export const realmContinuationReceiptSchema = z.strictObject({
  version: z.literal(1),
  dispatchId: realmContinuationRequestSchema.shape.dispatchId,
  adapterSessionId: z.string().min(1).max(200),
  status: z.enum(["accepted", "unknown", "not-submitted"]),
});
export type RealmContinuationRequest = z.infer<typeof realmContinuationRequestSchema>;
export type RealmContinuationReceipt = z.infer<typeof realmContinuationReceiptSchema>;
export type RealmContinuationObservation = Omit<RealmContinuationAuthority, "purpose" | "service">;
export const realmContinuationPath = "/eve/v1/internal/hosted-operator/realm-continuation";
const technicalWaitSchema = z.object({
  kind: z.literal("question"),
  requestId: z.string().min(1),
  prompt: z.string(),
  action: z.object({
    kind: z.literal("tool-call"),
    toolName: z.literal("prepare-app-hosted-runtime"),
    callId: z.string().min(1),
    input: z
      .object({
        operationRef: z.string(),
        planDigest: z.string(),
        plan: hostedOperatorPlanSchema,
        appId: z.string(),
        branch: z.string(),
        projectId: z.string(),
        environment: z.literal("preview"),
      })
      .optional(),
  }),
});

/** Raw framework provenance and the frozen challenge identify the technical wait, independent of prose. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the native raw pending-request parsing boundary.
export const isRealmContinuationTechnicalWait = (
  record: HostedRuntimeJournalRecord,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The following safeParse is the raw native input boundary.
  request: unknown,
): boolean => {
  const parsed = technicalWaitSchema.safeParse(request);
  const { operator } = record;
  const link = operator?.identityLink;
  if (!parsed.success || operator === undefined || link === undefined) {
    return false;
  }
  const { input, callId } = parsed.data.action;
  const { selection } = operator.plan;
  const sameOperation =
    input === undefined
      ? callId === record.approvedByCallId
      : [
          input.operationRef === operator.operationRef,
          input.planDigest === operator.planDigest,
          operatorPlanDigest(input.plan) === operator.planDigest,
          input.appId === selection.appId,
          input.branch === selection.branch,
          input.projectId === selection.projectId,
          input.environment === selection.environment,
        ].every(Boolean);
  if (!sameOperation) {
    return false;
  }
  const matches = [...parsed.data.prompt.matchAll(/https:\/\/[^\s<>"')]+/gu)].filter(([value]) => {
    try {
      const url = new URL(value);
      return [
        url.origin === link.browserOrigin,
        url.pathname === "/api/auth/platform/operator-link",
        url.username === "",
        url.password === "",
        url.hash === "",
        realmIdentityNonceSha256(url.searchParams.get("nonce") ?? "") === link.nonceSha256,
        url.searchParams.get("ownerSessionId") === link.ownerSessionId,
        url.searchParams.get("bootstrapPlanDigest") === link.bootstrapPlanDigest,
        url.searchParams.get("authResourceId") === link.authResourceId,
        url.searchParams.get("organizationId") === link.organizationId,
        url.searchParams.get("operationRef") === (link.browserSession?.operationRef ?? null),
        url.searchParams.get("participantProgramDigest") ===
          (link.browserSession?.participantProgramDigest ?? null),
      ].every(Boolean);
    } catch {
      return false;
    }
  });
  return matches.length > 0;
};
type State = NonNullable<HostedRuntimeJournalRecord["realmContinuation"]>;
export interface RealmContinuationPorts {
  store: Pick<HostedRuntimeJournalStore, "read" | "compareAndSet">;
  /** Re-read canonical owner, membership, adapter binding, operation and actual approval. */
  observe: (context: HostedOperatorContext) => Promise<RealmContinuationObservation | undefined>;
  seal: (observation: RealmContinuationObservation) => string;
  dispatch: (request: RealmContinuationRequest) => Promise<RealmContinuationReceipt>;
  reconcile: (request: RealmContinuationRequest) => Promise<RealmContinuationReceipt>;
  now?: () => number;
}

/** Stable logical delivery identity, independent of encryption randomness or HTTP attempts. */
export const realmContinuationDispatchId = (value: RealmContinuationObservation) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "realm-continuation-v1",
        value.authority.issuer,
        value.authority.audience,
        value.authority.workspaceId,
        value.authority.ownerUserId,
        value.ownerSessionId,
        value.adapterSessionId,
        value.appId,
        value.operationRef,
        value.approvedPlanDigest,
        value.nonceSha256,
        value.reason,
      ]),
    )
    .digest("hex");

/** The consumed proof is itself the durable intent; expiry never fabricates a captured identity. */
export const observeRealmContinuationRecord = (input: {
  context: HostedOperatorContext;
  record: HostedRuntimeJournalRecord;
  initiator: RealmContinuationObservation["initiator"];
  now: number;
}): RealmContinuationObservation | undefined => {
  const { context, record } = input;
  const { operator } = record;
  const link = operator?.identityLink;
  if (operator === undefined || link === undefined) {
    return undefined;
  }
  const owner = context.ownerContext;
  if (
    ![
      owner !== undefined,
      owner?.sessionId === context.target.sessionId,
      link.ownerSessionId === owner?.sessionId,
      record.request.sessionId === owner?.sessionId,
      record.request.appId === context.target.appId,
      operator.planDigest === operatorPlanDigest(operator.plan),
      operator.planDigest === link.bootstrapPlanDigest,
    ].every(Boolean) ||
    owner === undefined
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  let reason: RealmContinuationObservation["reason"] | undefined;
  if (
    [
      link.consumedAt !== undefined,
      link.proofRef !== undefined,
      link.proofSha256 !== undefined,
    ].every(Boolean) &&
    link.proofRef !== undefined &&
    link.proofSha256 !== undefined
  ) {
    reason = { kind: "consumed-proof", proofRef: link.proofRef, proofSha256: link.proofSha256 };
  } else if (Date.parse(link.expiresAt) <= input.now) {
    reason = { kind: "expired-technical-wait", expiresAt: link.expiresAt };
  }
  if (reason === undefined) {
    return undefined;
  }
  return {
    authority: context.authority,
    initiator: input.initiator,
    ownerSessionId: owner.sessionId,
    adapterSessionId: owner.adapterSessionId,
    appId: context.target.appId,
    operationRef: operator.operationRef,
    approvedPlanDigest: operator.planDigest,
    nonceSha256: link.nonceSha256,
    reason,
  };
};

/** One native logical delivery, with durable claim and read-only reconciliation after uncertain I/O. */
export const createHostedOperatorRealmContinuation = (ports: RealmContinuationPorts) => {
  const now = ports.now ?? Date.now;
  const checkpoint = async (
    context: HostedOperatorContext,
    expected: State,
    status: State["status"],
  ) => {
    const currentObservation = await ports.observe(context);
    if (
      currentObservation === undefined ||
      realmContinuationDispatchId(currentObservation) !== expected.dispatchId
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    const current = await ports.store.read(context);
    if (current?.record.realmContinuation?.dispatchId !== expected.dispatchId) {
      return;
    }
    if (current.record.realmContinuation.status === "accepted") {
      return;
    }
    await ports.store.compareAndSet({
      ...context,
      expectedRevision: current.revision,
      now: new Date(now()),
      record: {
        ...current.record,
        realmContinuation: {
          ...current.record.realmContinuation,
          status,
          ...(status === "accepted" ? { acceptedAt: new Date(now()).toISOString() } : {}),
        },
      },
    });
  };
  return async (context: HostedOperatorContext): Promise<"idle" | "accepted" | "unknown"> => {
    const observed = await ports.observe(context);
    if (observed === undefined) {
      return "idle";
    }
    const dispatchId = realmContinuationDispatchId(observed);
    const snapshot = await ports.store.read(context);
    if (snapshot === undefined) {
      throw new HostedOperatorError("authorization_required");
    }
    let state = snapshot.record.realmContinuation;
    if (state?.dispatchId === dispatchId && state.status === "accepted") {
      return "accepted";
    }
    const request = { version: 1 as const, dispatchId, authority: ports.seal(observed) };
    let receipt: RealmContinuationReceipt;
    if (state?.dispatchId === dispatchId) {
      receipt = realmContinuationReceiptSchema.parse(await ports.reconcile(request));
      if (
        receipt.dispatchId !== dispatchId ||
        receipt.adapterSessionId !== observed.adapterSessionId
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      // Only the native receiver can definitively establish that this logical delivery was not submitted.
      if (receipt.status === "not-submitted") {
        receipt = await ports.dispatch(request);
      }
    } else {
      state = {
        dispatchId,
        operationRef: observed.operationRef,
        approvedPlanDigest: observed.approvedPlanDigest,
        nonceSha256: observed.nonceSha256,
        adapterSessionId: observed.adapterSessionId,
        claimedAt: new Date(now()).toISOString(),
        status: "claimed",
      };
      const claimed = await ports.store.compareAndSet({
        ...context,
        expectedRevision: snapshot.revision,
        record: { ...snapshot.record, realmContinuation: state },
        now: new Date(now()),
      });
      if (claimed === undefined) {
        return "unknown";
      }
      try {
        receipt = realmContinuationReceiptSchema.parse(await ports.dispatch(request));
      } catch {
        await checkpoint(context, state, "unknown");
        return "unknown";
      }
    }
    receipt = realmContinuationReceiptSchema.parse(receipt);
    if (
      receipt.dispatchId !== dispatchId ||
      receipt.adapterSessionId !== observed.adapterSessionId
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    await checkpoint(context, state, receipt.status === "accepted" ? "accepted" : "unknown");
    return receipt.status === "accepted" ? "accepted" : "unknown";
  };
};

/** Normal authenticated get/idle hook; caller scopes never become the initiating identity. */
export const reconcileHostedOperatorRealmContinuation = async (input: {
  principal: HostedPrincipal;
  sessionId: string;
  adapterSessionId: string;
  sourceHandoffId?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}) => {
  const { openHostedOperatorCompositionResources } =
    await import("./hosted-operator-source-configuration");
  const resources = await openHostedOperatorCompositionResources(input.environment);
  try {
    const context = await resources.controlPlane.resolveOwnerRealmContinuationContext(input);
    return context === undefined
      ? "idle"
      : await resources.controlPlane.reconcileOwnerRealmContinuation(context);
  } finally {
    await resources.controlPlane.close();
  }
};

const identityWaitContext = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The existing operator client parses native auth before resolving owner context.
  input: HostedRuntimeIdentityWaitInvocation & {
    sessionAuth: unknown;
    callbackExecution?: HostedOperatorCallbackExecution;
  },
) => {
  const { hostedOperatorClientForSession } = await import("./hosted-operator-client");
  const client = await hostedOperatorClientForSession(
    input.sessionAuth,
    input.adapterSessionId,
    process.env,
    input.callbackExecution,
  );
  const owner = client.ownerContext;
  if (owner === undefined || owner === null) {
    throw new HostedOperatorError("authorization_required");
  }
  const { openHostedOperatorCompositionResources } =
    await import("./hosted-operator-source-configuration");
  const resources = await openHostedOperatorCompositionResources();
  try {
    const context = await resources.controlPlane.resolveOwnerRealmContinuationContext({
      principal: owner.principal,
      sessionId: owner.sessionId,
      adapterSessionId: owner.adapterSessionId,
      ...(owner.kind === "handoff" ? { sourceHandoffId: owner.sourceHandoffId } : {}),
    });
    if (context === undefined) {
      throw new HostedOperatorError("authorization_required");
    }
    return { context, resources, adapterSessionId: owner.adapterSessionId };
  } catch (error) {
    await resources.controlPlane.close();
    throw error;
  }
};

/** Called only by the authored tool's private step after its hook registration commits. */
export const registerHostedRuntimeIdentityWait = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native auth is parsed by identityWaitContext's existing owner client.
  input: HostedRuntimeIdentityWaitRegistration & {
    sessionAuth: unknown;
    callbackExecution?: HostedOperatorCallbackExecution;
  },
) => {
  const { context, resources, adapterSessionId } = await identityWaitContext(input);
  try {
    return await resources.controlPlane.registerOwnerRealmIdentityWait(context, {
      ...input,
      adapterSessionId,
    });
  } finally {
    await resources.controlPlane.close();
  }
};

/** A hook payload is a wakeup only; current owner and canonical proof/expiry establish its meaning. */
export const acknowledgeHostedRuntimeIdentityWait = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native auth is parsed by identityWaitContext's existing owner client.
  input: HostedRuntimeIdentityWaitInvocation & {
    sessionAuth: unknown;
    eventId: string;
    callbackExecution?: HostedOperatorCallbackExecution;
  },
) => {
  const { context, resources, adapterSessionId } = await identityWaitContext(input);
  try {
    return await resources.controlPlane.acknowledgeOwnerRealmIdentityWait(context, {
      ...input,
      adapterSessionId,
    });
  } finally {
    await resources.controlPlane.close();
  }
};
