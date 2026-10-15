import type { WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import type { HostedEveStore } from "../eve/hosted-store";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import {
  createPrivateHostedApprovalRecorder,
  readPrivateHostedApproval,
} from "../eve/private-hosted-approval";
import type { PrivateHostedApprovalReceipt } from "../eve/private-hosted-approval";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorOwnerContextSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type {
  OperatorOwnerContext,
  OperatorPublicResult,
} from "../provisioning/hosted-operator-contract";
import type { hostedOperatorClientForSession } from "../provisioning/hosted-operator-client";
import { readHostedOperatorOwnerReaderConfiguration } from "../provisioning/hosted-operator-owner-context";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import { tenantKeyFor } from "../eve/hosted-auth";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import type { HostedRuntimeApprovalEnvelope } from "./prepare-app-hosted-runtime-step";

export const hostedRuntimePreparationInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: z.string().min(1),
  environment: z.literal("preview"),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: z.string().min(1),
});

type Context = Pick<WorkflowStepToolContext, "abortSignal" | "session">;
type Operator = Pick<
  Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  "ownerContext" | "request" | "sessionId"
>;

/** Private execution provenance; never accepted from the model or returned in public results. */
export interface HostedRuntimePriorApproval {
  approvalId: string;
  callId: string;
}

const sameInput = (
  receipt: PrivateHostedApprovalReceipt,
  input: z.infer<typeof hostedRuntimePreparationInputSchema>,
) =>
  [
    receipt.toolName === "prepare-app-hosted-runtime",
    receipt.toolInput.operationRef === input.operationRef,
    receipt.toolInput.planDigest === input.planDigest,
    operatorPlanDigest(receipt.toolInput.plan) === input.planDigest,
    sameOperatorSelection(receipt.toolInput.plan.selection, input.plan.selection),
    receipt.toolInput.appId === input.appId,
    receipt.toolInput.branch === input.branch,
    receipt.toolInput.projectId === input.projectId,
    receipt.toolInput.environment === input.environment,
  ].every(Boolean);

const matchesRestoredApproval = (
  restored: OperatorPublicResult,
  original: z.infer<typeof hostedRuntimePreparationInputSchema>,
) =>
  [
    restored.status === "planned",
    restored.appId === original.appId,
    restored.operationRef === original.operationRef,
    restored.planDigest === original.planDigest,
    restored.plan !== undefined && operatorPlanDigest(restored.plan) === original.planDigest,
  ].every(Boolean);

/** Reuses only a real terminal receipt and independently checks the current protected operation. */
export const createHostedRuntimePriorApprovalReader =
  (dependencies: { store: Pick<HostedEveStore, "getSession">; now: () => number }) =>
  async (
    input: HostedRuntimeApprovalEnvelope,
    ctx: Context,
    operator: Operator,
  ): Promise<HostedRuntimePriorApproval | null> => {
    ctx.abortSignal.throwIfAborted();
    const parsed = hostedRuntimePreparationInputSchema.parse(input);
    const owner = operatorOwnerContextSchema.parse(operator.ownerContext);
    const selection = { ...parsed.plan.selection, sessionId: owner.sessionId };
    const inputMatches = [
      parsed.plan.action === "prepare",
      operatorPlanDigest(parsed.plan) === parsed.planDigest,
      sameOperatorSelection(parsed.plan.selection, selection),
      parsed.appId === selection.appId,
      parsed.branch === selection.branch,
      parsed.projectId === selection.projectId,
      parsed.environment === selection.environment,
      operator.sessionId === owner.sessionId,
      owner.adapterSessionId === ctx.session.id,
      Date.parse(parsed.plan.retention.expiresAt) > dependencies.now(),
    ].every(Boolean);
    if (!inputMatches) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const session = toDurableHostedSessionRecord(
      hostedSessionRecordSchema.parse(
        await dependencies.store.getSession(owner.principal, owner.sessionId),
      ),
    );
    const sessionMatches = [
      session.sessionId === owner.sessionId,
      session.adapterSessionId === owner.adapterSessionId,
      session.adapterGeneration === owner.adapterGeneration,
      session.principal.ownerUserId === owner.principal.ownerUserId,
      session.principal.workspaceId === owner.principal.workspaceId,
      session.principal.issuer === owner.principal.issuer,
      session.principal.audience === owner.principal.audience,
    ].every(Boolean);
    if (!sessionMatches) {
      throw new HostedOperatorError("authorization_required");
    }
    const matching = (session.privateApprovalReceipts ?? [])
      .filter((receipt) => sameInput(receipt, parsed))
      .toSorted((left, right) => left.sequence - right.sequence);
    const latest = matching.at(-1);
    if (latest?.outcome === "cancelled") {
      throw new HostedOperatorError("authorization_required");
    }
    const original = matching.find((receipt) => receipt.outcome === "approved");
    if (original === undefined) {
      return null;
    }
    const receipt = await readPrivateHostedApproval({
      action: "prepare",
      callId: original.callId,
      planDigest: parsed.planDigest,
      principal: owner.principal,
      requestId: original.requestId,
      selection,
      sessionId: owner.sessionId,
      store: dependencies.store,
    });
    if (
      receipt?.outcome !== "approved" ||
      receipt.responderPrincipalId !== owner.principal.ownerUserId ||
      !sameInput(receipt, parsed)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    let current = await operator.request(
      {
        action: "status",
        operationRef: parsed.operationRef,
        selection,
      },
      ctx.abortSignal,
    );
    ctx.abortSignal.throwIfAborted();
    if ([current.status === "blocked", current.code === "resource_mismatch"].every(Boolean)) {
      const restored = await operator.request(
        {
          action: "plan",
          operation: "prepare",
          selection,
          ...(parsed.plan.normalActorProgram === undefined
            ? {}
            : {
                normalActorProgram: parsed.plan.normalActorProgram,
              }),
        },
        ctx.abortSignal,
      );
      ctx.abortSignal.throwIfAborted();
      if (!matchesRestoredApproval(restored, parsed)) {
        throw new HostedOperatorError(restored.code ?? "resource_mismatch");
      }
      current = await operator.request(
        { action: "status", operationRef: parsed.operationRef, selection },
        ctx.abortSignal,
      );
    }
    ctx.abortSignal.throwIfAborted();
    if (
      current.status === "blocked" ||
      current.appId !== parsed.appId ||
      current.operationRef !== parsed.operationRef ||
      current.planDigest !== parsed.planDigest
    ) {
      throw new HostedOperatorError(current.code ?? "resource_mismatch");
    }
    return { approvalId: receipt.requestId, callId: receipt.callId };
  };

type ApprovalStore = Pick<HostedEveStore, "getSession" | "recordPrivateApprovalReceipts">;
let deploymentStore: Promise<ApprovalStore> | undefined;
const openDeploymentStore = async (): Promise<ApprovalStore> => {
  const configuration = readHostedOperatorOwnerReaderConfiguration(process.env);
  const [{ openHostedPostgresDatabase }, { createPostgresHostedEveStore }] = await Promise.all([
    import("../db/hosted-postgres"),
    import("../eve/postgres-hosted-store"),
  ]);
  return createPostgresHostedEveStore(openHostedPostgresDatabase(configuration.databaseUrl));
};

/** Existing server-owned owner/session/receipt APIs, with no new private operator protocol. */
export const readHostedRuntimePriorApproval = async (
  input: HostedRuntimeApprovalEnvelope,
  ctx: Context,
  existingOperator?: Operator,
): Promise<HostedRuntimePriorApproval | null> => {
  const { hostedOperatorClientForSession: resolveOperator } =
    await import("../provisioning/hosted-operator-client");
  const operator = existingOperator ?? (await resolveOperator(ctx.session.auth, ctx.session.id));
  deploymentStore ??= openDeploymentStore();
  const pendingStore = deploymentStore;
  let store: ApprovalStore;
  try {
    store = await pendingStore;
  } catch (error) {
    if (deploymentStore === pendingStore) {
      deploymentStore = undefined;
    }
    throw error;
  }
  return await createHostedRuntimePriorApprovalReader({ store, now: Date.now })(
    input,
    ctx,
    operator,
  );
};

/** Capture real native request/settlement events with Builder's own workload identity. */
export const captureHostedRuntimeApproval = async (input: {
  ownerContext: OperatorOwnerContext;
  store: ApprovalStore;
  baseUrl: string;
  workloadIdentity: HostedWorkloadIdentity;
  signal: AbortSignal;
  fetchImplementation?: typeof fetch;
}) => {
  input.signal.throwIfAborted();
  const owner = operatorOwnerContextSchema.parse(input.ownerContext);
  const recorder = createPrivateHostedApprovalRecorder({
    principal: owner.principal,
    sessionId: owner.sessionId,
    store: input.store,
  });
  const transport = createSameOriginEveTransport({
    config: { baseUrl: input.baseUrl },
    workloadIdentity: input.workloadIdentity,
    fetchImplementation: async (url, init) =>
      await (input.fetchImplementation ?? fetch)(url, {
        ...init,
        signal:
          init?.signal === undefined || init.signal === null
            ? input.signal
            : AbortSignal.any([input.signal, init.signal]),
      }),
    verifyReadAuthority: async ({ principal, sessionId, adapterSessionId }) => {
      input.signal.throwIfAborted();
      const raw = await input.store.getSession(owner.principal, owner.sessionId);
      const parsed = hostedSessionRecordSchema.safeParse(raw);
      if (!parsed.success) {
        return false;
      }
      const session = toDurableHostedSessionRecord(parsed.data);
      return [
        sessionId === owner.sessionId,
        adapterSessionId === owner.adapterSessionId,
        tenantKeyFor(principal) === tenantKeyFor(owner.principal),
        session.sessionId === owner.sessionId,
        session.adapterSessionId === owner.adapterSessionId,
        session.adapterGeneration === owner.adapterGeneration,
        tenantKeyFor(session.principal) === tenantKeyFor(owner.principal),
      ].every(Boolean);
    },
  });
  if (transport.observe === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  await transport.observe({
    adapterSessionId: owner.adapterSessionId,
    principal: owner.principal,
    sessionId: owner.sessionId,
    onEvent: () => {
      /* Only private approval events are captured here. */
    },
    onPrivateEvent: recorder.observe,
    readDeadline: true,
  });
  input.signal.throwIfAborted();
};

/** Execution-only catch-up; a failed redundant read cannot override a real concurrent receipt. */
export const createHostedRuntimeExecutionApprovalReader =
  (dependencies: {
    readPrior: (
      input: HostedRuntimeApprovalEnvelope,
      ctx: Context,
      operator: Operator,
    ) => Promise<HostedRuntimePriorApproval | null>;
    capture: (ctx: Context, operator: Operator) => Promise<void>;
  }) =>
  async (input: HostedRuntimeApprovalEnvelope, ctx: Context, operator: Operator) => {
    const prior = await dependencies.readPrior(input, ctx, operator);
    if (prior !== null) {
      return prior;
    }
    ctx.abortSignal.throwIfAborted();
    try {
      await dependencies.capture(ctx, operator);
    } catch {
      // Only the exact fresh receipt read below decides authority, even after a lost capture response.
    }
    ctx.abortSignal.throwIfAborted();
    return await dependencies.readPrior(input, ctx, operator);
  };

export const readHostedRuntimeExecutionApproval = createHostedRuntimeExecutionApprovalReader({
  readPrior: readHostedRuntimePriorApproval,
  capture: async (ctx, operator) => {
    const configuration = readHostedOperatorOwnerReaderConfiguration(process.env);
    deploymentStore ??= openDeploymentStore();
    const store = await deploymentStore;
    await captureHostedRuntimeApproval({
      ownerContext: operatorOwnerContextSchema.parse(operator.ownerContext),
      store,
      baseUrl: new URL(configuration.resource).origin,
      workloadIdentity: createVercelWorkloadIdentity(),
      signal: ctx.abortSignal,
    });
  },
});
