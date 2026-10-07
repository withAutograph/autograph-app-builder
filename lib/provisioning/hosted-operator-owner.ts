import type { HostedEveStore } from "../eve/hosted-store";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import { readPreparedVercelAccess } from "../agent/prepared-provider-context";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type {
  OperatorOwnerContext,
  OperatorSelection,
  HostedOperatorPlan,
} from "./hosted-operator-contract";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  createPrivateHostedApprovalRecorder,
  readPrivateHostedApproval,
} from "../eve/private-hosted-approval";
import type { HostedEveTransport } from "../eve/hosted-service";

type Authority = OperatorOwnerContext["authority"];
type AccessReader = Parameters<typeof readPreparedVercelAccess>[0]["readCredential"];
type VerifierKeyResolver = Parameters<typeof createOperatorWorkloadVerifier>[1];

export interface HostedOperatorOwnerDependencies {
  workloadPolicy: OperatorWorkloadPolicy;
  keyResolver?: VerifierKeyResolver;
  eve: Pick<HostedEveStore, "getSession">;
  handoffs: Pick<BuilderHandoffStore, "read">;
  membership: HostedWorkspaceMembership;
  readVercelCredential: AccessReader;
  fetch?: typeof fetch;
  apiOrigin?: string;
}

const sameAuthority = (left: Authority, right: Authority) =>
  left.issuer === right.issuer &&
  left.audience === right.audience &&
  left.workspaceId === right.workspaceId &&
  left.ownerUserId === right.ownerUserId;

const samePrincipal = (left: HostedPrincipal, right: HostedPrincipal) =>
  sameAuthority(left, right) &&
  JSON.stringify([...left.scopes].toSorted()) === JSON.stringify([...right.scopes].toSorted());

const unavailable = () => new HostedOperatorError("authorization_required");

const ownerContextFromHint = (hint: OperatorOwnerContext | undefined) => {
  const parsed = operatorOwnerContextSchema.safeParse(hint);
  if (!parsed.success) {
    throw unavailable();
  }
  const owner = parsed.data;
  const principal = hostedPrincipalSchema.parse(owner.principal);
  if (!sameAuthority(owner.authority, principal)) {
    throw unavailable();
  }
  return { owner, principal };
};

// oxlint-disable-next-line eslint/complexity -- Each owner, handoff, membership and Vercel fact is a distinct required authority check.
const readOwnedState = async (
  deps: HostedOperatorOwnerDependencies,
  owner: OperatorOwnerContext,
  principal: HostedPrincipal,
  selection: OperatorSelection,
) => {
  if (selection.sessionId !== owner.sessionId || selection.environment !== "preview") {
    throw unavailable();
  }
  const handoffValue = await deps.handoffs.read({
    authority: owner.authority,
    handoffId: owner.sourceHandoffId,
  });
  const handoff = builderHandoffRecordSchema.safeParse(handoffValue);
  if (!handoff.success) {
    throw unavailable();
  }
  // oxlint-disable-next-line sonarjs/expression-complexity -- Handoff ID, owner, session, and app are one persisted linkage.
  if (
    handoff.data.handoffId !== owner.sourceHandoffId ||
    handoff.data.sessionId !== owner.sessionId ||
    !sameAuthority(handoff.data.authority, owner.authority) ||
    handoff.data.intent.appId !== selection.appId
  ) {
    throw unavailable();
  }

  const sessionValue = await deps.eve.getSession(principal, owner.sessionId);
  let session: ReturnType<typeof toDurableHostedSessionRecord> | null = null;
  let sessionVersion: 1 | 2 | undefined;
  if (sessionValue !== null) {
    const parsedSession = hostedSessionRecordSchema.safeParse(sessionValue);
    if (parsedSession.success) {
      sessionVersion = parsedSession.data.version;
      try {
        session = toDurableHostedSessionRecord(parsedSession.data);
      } catch {
        throw unavailable();
      }
    }
  }
  if (session === null) {
    throw unavailable();
  }
  if (session.version !== 2) {
    throw unavailable();
  }
  const sessionMatches = [
    session.sessionId === owner.sessionId,
    sessionVersion === 1 || session.sourceHandoffId === owner.sourceHandoffId,
    session.adapterSessionId === owner.adapterSessionId,
    session.adapterGeneration === owner.adapterGeneration,
    samePrincipal(session.principal, principal),
  ].every(Boolean);
  if (!sessionMatches) {
    throw unavailable();
  }
  if (!(await deps.membership.isMember({ principal, workspaceId: owner.authority.workspaceId }))) {
    throw unavailable();
  }

  const vercel = handoff.data.intent.provisioning?.vercel;
  if (vercel?.status !== "succeeded" || vercel.projectId !== selection.projectId) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const accessInput: Parameters<typeof readPreparedVercelAccess>[0] = {
    authority: owner.authority,
    intent: handoff.data.intent,
    readCredential: deps.readVercelCredential,
  };
  if (deps.fetch !== undefined) {
    accessInput.fetch = deps.fetch;
  }
  if (deps.apiOrigin !== undefined) {
    accessInput.apiOrigin = deps.apiOrigin;
  }
  const access = await readPreparedVercelAccess(accessInput);
  if (access.status !== "ready") {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (access.project === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const accessMatches = [
    access.project.id === selection.projectId,
    access.scope.installationId === vercel.installationId,
    access.scope.id === vercel.scope.id,
    access.scope.type === vercel.scope.type,
  ].every(Boolean);
  if (!accessMatches) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const target = hostedRuntimeTargetSchema.parse({
    appId: selection.appId,
    branch: selection.branch,
    environment: selection.environment,
    installationId: access.scope.installationId,
    projectId: access.project.id,
    scopeId: access.scope.id,
    scopeType: access.scope.type,
    sessionId: selection.sessionId,
  });
  return { handoff: handoff.data, session, target };
};

/**
 * Server-only delegated authority for the exact Builder workload. The owner tuple
 * is only a lookup hint: every call re-reads the owner-scoped handoff, Eve row,
 * active membership, and Vercel grant before exposing an operator context.
 */
export const createHostedOperatorOwnerAuthority = (deps: HostedOperatorOwnerDependencies) => {
  const verifyWorkload = createOperatorWorkloadVerifier(deps.workloadPolicy, deps.keyResolver);

  const resolve = async (
    request: Request,
    selection: OperatorSelection,
    hint: OperatorOwnerContext | undefined,
  ): Promise<HostedOperatorContext> => {
    await verifyWorkload(request);
    const { owner, principal } = ownerContextFromHint(hint);
    const { target } = await readOwnedState(deps, owner, principal, selection);
    return { authority: owner.authority, ownerContext: owner, target };
  };

  const assertAuthorized = async (input: HostedOperatorContext & { plan: HostedOperatorPlan }) => {
    const owner = operatorOwnerContextSchema.parse(input.ownerContext);
    const { principal } = ownerContextFromHint(owner);
    const current = await readOwnedState(deps, owner, principal, input.plan.selection);
    // oxlint-disable-next-line sonarjs/expression-complexity -- Approval is accepted only when every terminal receipt binding matches.
    if (
      !sameAuthority(input.authority, owner.authority) ||
      JSON.stringify(current.target) !== JSON.stringify(input.target) ||
      current.session.adapterGeneration !== owner.adapterGeneration ||
      current.session.adapterSessionId !== owner.adapterSessionId
    ) {
      throw unavailable();
    }
  };
  return {
    assertAuthorized,
    authorize: resolve,
  };
};

/** Owner-scoped terminal approval reader; the durable digest binds the closed plan. */
export const createHostedOperatorReadApproval =
  (input: {
    eve: Pick<HostedEveStore, "getSession" | "recordPrivateApprovalReceipts">;
    journal: Pick<HostedRuntimeJournalStore, "read">;
    /**
     * Operator-owned read-only Eve transport. Configure its own project-scoped
     * workload identity with explicit GET access to the canonical session stream;
     * never borrow a Builder bearer or infer access when this capability is absent.
     */
    observe: NonNullable<HostedEveTransport["observe"]>;
  }) =>
  async (
    context: HostedOperatorContext & {
      action: "prepare" | "cleanup";
      callId: string;
      planDigest: string;
    },
  ) => {
    const owner = operatorOwnerContextSchema.safeParse(context.ownerContext);
    const row = await input.journal.read(context);
    const current = row?.record.operator;
    if (!owner.success || current === undefined) {
      throw unavailable();
    }
    if (
      current.planDigest !== context.planDigest ||
      current.plan.action !== context.action ||
      operatorPlanDigest(current.plan) !== context.planDigest
    ) {
      throw unavailable();
    }
    const readReceipt = () => readPrivateHostedApproval({
      action: context.action,
      callId: context.callId,
      planDigest: context.planDigest,
      principal: owner.data.principal,
      selection: current.plan.selection,
      sessionId: owner.data.sessionId,
      store: input.eve,
    });
    let receipt = await readReceipt();
    if (receipt === null) {
      // The tool can resume before the background observer stores this receipt.
      // Re-read Eve's authenticated durable tail using the owner-bound adapter
      // ID, and persist only server-emitted terminal approval settlements.
      const recorder = createPrivateHostedApprovalRecorder({
        principal: owner.data.principal,
        sessionId: owner.data.sessionId,
        store: input.eve,
      });
      await input.observe({
        adapterSessionId: owner.data.adapterSessionId,
        onEvent() {},
        onPrivateEvent: recorder.observe,
        principal: owner.data.principal,
        readDeadline: true,
        sessionId: owner.data.sessionId,
      });
      receipt = await readReceipt();
    }
    if (receipt === null) {
      throw unavailable();
    }
    const receiptMatches = [
      receipt.outcome === "approved",
      receipt.responderPrincipalId === owner.data.principal.ownerUserId,
      receipt.toolInput.planDigest === context.planDigest,
      operatorPlanDigest(receipt.toolInput.plan) === context.planDigest,
      receipt.toolInput.operationRef === current.operationRef,
      receipt.toolInput.appId === current.plan.selection.appId,
      receipt.toolInput.branch === current.plan.selection.branch,
      receipt.toolInput.projectId === current.plan.selection.projectId,
    ].every(Boolean);
    if (!receiptMatches) {
      throw unavailable();
    }
    return {
      action: context.action,
      approvalId: receipt.requestId,
      approved: true,
      callId: receipt.callId,
      planDigest: receipt.toolInput.planDigest,
    };
  };
