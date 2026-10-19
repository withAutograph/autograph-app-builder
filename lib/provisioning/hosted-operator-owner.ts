import { sharedHostProtectionDeliveryProvenance } from "./hosted-operator-shared-host-protection-successor";
import {
  readSealedRealmContinuationAuthority,
  realmContinuationPrincipal,
} from "../hosted/realm-continuation-authority";
import type {
  RealmContinuationAuthority,
  RealmContinuationVerificationOptions,
} from "../hosted/realm-continuation-authority";
import type { HostedEveStore } from "../eve/hosted-store";
import { projectSettingsDeliveryProvenance } from "./hosted-operator-project-settings-successor";
import { retentionRenewalDeliveryProvenance } from "./hosted-operator-retention-renewal";
import { matchRetainedMembershipInspectionProvenance } from "./hosted-operator-membership-inspection-provenance";
import { readyReplacementPriorOperators } from "./hosted-operator-native-preview-recovery";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import {
  readOwnerVercelProjectAccess,
  readPreparedVercelAccess,
} from "../agent/prepared-provider-context";
import type { PreparedVercelAccess } from "../agent/prepared-provider-context";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPlanDigest,
  retainedOperatorAuthSchema,
  sameOperatorSelection,
  sameOperatorPlanExceptExpiry,
} from "./hosted-operator-contract";
import type {
  OperatorOwnerContext,
  OperatorSelection,
  HostedOperatorPlan,
  HostedOperatorRecord,
} from "./hosted-operator-contract";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  createPrivateHostedApprovalRecorder,
  readPrivateHostedApproval,
  privateHostedApprovalReceiptSchema,
} from "../eve/private-hosted-approval";
import type { HostedEveTransport } from "../eve/hosted-service";

import {
  createHostedOperatorConsentDiagnostic,
  observeOperatorPlanStage,
} from "./hosted-operator-consent-diagnostic";
import type { HostedOperatorConsentDiagnosticSink } from "./hosted-operator-consent-diagnostic";

type Authority = OperatorOwnerContext["authority"];
type AccessReader = Parameters<typeof readPreparedVercelAccess>[0]["readCredential"];
type VerifierKeyResolver = Parameters<typeof createOperatorWorkloadVerifier>[1];

export interface HostedOperatorOwnerDependencies {
  journal?: Pick<HostedRuntimeJournalStore, "read">;
  realmContinuation?: RealmContinuationVerificationOptions;
  workloadPolicy: OperatorWorkloadPolicy;
  keyResolver?: VerifierKeyResolver;
  eve: Pick<HostedEveStore, "getSession">;
  handoffs: Pick<BuilderHandoffStore, "read">;
  membership: HostedWorkspaceMembership;
  listVercelInstallations: (
    authority: Authority,
  ) => Promise<readonly Pick<VercelInstallationBinding, "active" | "installationId">[]>;
  readVercelCredential: AccessReader;
  fetch?: typeof fetch;
  diagnosticSink?: HostedOperatorConsentDiagnosticSink;
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
const resourceMismatch = () => new HostedOperatorError("resource_mismatch");
type HostedSessionVersion = 1 | 2 | undefined;

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

const readCurrentOwnedSession = async (
  deps: { eve: Pick<HostedEveStore, "getSession"> },
  principal: HostedPrincipal,
  owner: OperatorOwnerContext,
) => {
  const sessionValue = await deps.eve.getSession(principal, owner.sessionId);
  let session: ReturnType<typeof toDurableHostedSessionRecord> | null = null;
  let sessionVersion: HostedSessionVersion;
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
  return { session, sessionVersion };
};

const assertDirectOwnerIdentity = (
  owner: OperatorOwnerContext,
  principal: HostedPrincipal,
  selection: Pick<OperatorSelection, "appId">,
  session: ReturnType<typeof toDurableHostedSessionRecord>,
  sessionVersion: HostedSessionVersion,
) => {
  const sessionMatches = [
    sessionVersion === 2,
    session.sourceHandoffId === undefined,
    session.sessionId === owner.sessionId,
    session.adapterSessionId === owner.adapterSessionId,
    session.adapterGeneration === owner.adapterGeneration,
    samePrincipal(session.principal, principal),
  ].every(Boolean);
  if (!sessionMatches) {
    throw unavailable();
  }
  if (session.appId === undefined || session.appId !== selection.appId) {
    throw resourceMismatch();
  }
};

const observeOwnerProjectFetch =
  (deps: HostedOperatorOwnerDependencies, selection: OperatorSelection): typeof fetch =>
  async (request, init) =>
    await observeOperatorPlanStage(
      selection.sessionId,
      "plan_owner_authorization",
      async () => {
        const response = await (deps.fetch ?? fetch)(request, init);
        if (response.status !== 200) {
          try {
            createHostedOperatorConsentDiagnostic(
              selection.sessionId,
              deps.diagnosticSink,
            )({
              boundary: "operator",
              phase: "inline",
              stage: "operator_request",
              outcome: "setup_unavailable",
              httpStatus: response.status,
              planningFailure: { stage: "plan_owner_authorization", errorClass: "unexpected" },
            });
          } catch {
            /* Diagnostics never change the provider request or response. */
          }
        }
        return response;
      },
      deps.diagnosticSink,
    );

const readDirectOwnerTarget = async (
  deps: HostedOperatorOwnerDependencies,
  owner: OperatorOwnerContext,
  principal: HostedPrincipal,
  selection: OperatorSelection,
  session: ReturnType<typeof toDurableHostedSessionRecord>,
  sessionVersion: HostedSessionVersion,
) => {
  assertDirectOwnerIdentity(owner, principal, selection, session, sessionVersion);
  const { listVercelInstallations } = deps;
  const installations = await listVercelInstallations(owner.authority);
  const installationIds = new Set<string>();
  for (const binding of installations) {
    if (binding.active) {
      installationIds.add(binding.installationId);
    }
  }
  const projectChecks = await Promise.all(
    [...installationIds].map(async (installationId) => {
      const accessInput: Parameters<typeof readOwnerVercelProjectAccess>[0] = {
        authority: owner.authority,
        installationId,
        projectId: selection.projectId,
        readCredential: deps.readVercelCredential,
      };
      accessInput.fetch = observeOwnerProjectFetch(deps, selection);
      if (deps.apiOrigin !== undefined) {
        accessInput.apiOrigin = deps.apiOrigin;
      }
      return await readOwnerVercelProjectAccess(accessInput);
    }),
  );
  let projectAccess: Extract<PreparedVercelAccess, { status: "ready" }> | undefined;
  for (const access of projectChecks) {
    if (access.status === "ready" && access.project?.id === selection.projectId) {
      if (projectAccess !== undefined) {
        throw resourceMismatch();
      }
      projectAccess = access;
    }
  }
  if (projectAccess?.project === undefined) {
    throw resourceMismatch();
  }
  const target = hostedRuntimeTargetSchema.parse({
    appId: selection.appId,
    branch: selection.branch,
    environment: selection.environment,
    installationId: projectAccess.scope.installationId,
    projectId: projectAccess.project.id,
    scopeId: projectAccess.scope.id,
    scopeType: projectAccess.scope.type,
    sessionId: selection.sessionId,
  });
  return { session, target };
};

const readHandoffOwnerIdentity = async (
  deps: HostedOperatorOwnerDependencies,
  owner: OperatorOwnerContext & { kind: "handoff" },
  principal: HostedPrincipal,
  selection: Pick<OperatorSelection, "appId">,
  session: ReturnType<typeof toDurableHostedSessionRecord>,
  sessionVersion: HostedSessionVersion,
) => {
  const handoffValue = await deps.handoffs.read({
    authority: owner.authority,
    handoffId: owner.sourceHandoffId,
  });
  const handoff = builderHandoffRecordSchema.safeParse(handoffValue);
  if (!handoff.success) {
    throw unavailable();
  }
  // oxlint-disable-next-line sonarjs/expression-complexity -- Handoff ID, owner, session, and app form one persisted linkage.
  if (
    handoff.data.handoffId !== owner.sourceHandoffId ||
    handoff.data.sessionId !== owner.sessionId ||
    !sameAuthority(handoff.data.authority, owner.authority) ||
    handoff.data.intent.appId !== selection.appId
  ) {
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

  return handoff;
};

const readHandoffOwnerTarget = async (
  deps: HostedOperatorOwnerDependencies,
  owner: OperatorOwnerContext & { kind: "handoff" },
  principal: HostedPrincipal,
  selection: OperatorSelection,
  session: ReturnType<typeof toDurableHostedSessionRecord>,
  sessionVersion: HostedSessionVersion,
) => {
  const handoff = await readHandoffOwnerIdentity(
    deps,
    owner,
    principal,
    selection,
    session,
    sessionVersion,
  );

  const vercel = handoff.data.intent.provisioning?.vercel;
  if (vercel?.status !== "succeeded" || vercel.projectId !== selection.projectId) {
    throw resourceMismatch();
  }
  const accessInput: Parameters<typeof readPreparedVercelAccess>[0] = {
    authority: owner.authority,
    intent: handoff.data.intent,
    readCredential: deps.readVercelCredential,
  };
  accessInput.fetch = observeOwnerProjectFetch(deps, selection);
  if (deps.apiOrigin !== undefined) {
    accessInput.apiOrigin = deps.apiOrigin;
  }
  const access = await readPreparedVercelAccess(accessInput);
  if (access.status !== "ready" || access.project === undefined) {
    throw resourceMismatch();
  }
  const accessMatches = [
    access.project.id === selection.projectId,
    access.scope.installationId === vercel.installationId,
    access.scope.id === vercel.scope.id,
    access.scope.type === vercel.scope.type,
  ].every(Boolean);
  if (!accessMatches) {
    throw resourceMismatch();
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

const readRealmOwnerRestriction = (
  deps: Pick<HostedOperatorOwnerDependencies, "realmContinuation">,
  owner: OperatorOwnerContext,
  appId: string,
): RealmContinuationAuthority | undefined => {
  if (owner.realmContinuation === undefined) {
    return undefined;
  }
  try {
    const claim = readSealedRealmContinuationAuthority(
      owner.realmContinuation.sealedAuthority,
      deps.realmContinuation,
    );
    const matches = [
      claim.appId === appId,
      claim.ownerSessionId === owner.sessionId,
      claim.adapterSessionId === owner.adapterSessionId,
      sameAuthority(claim.authority, owner.authority),
      samePrincipal(realmContinuationPrincipal(claim), owner.principal),
      claim.initiator.attributes["autograph:source-handoff-id"] ===
        (owner.kind === "handoff" ? owner.sourceHandoffId : undefined),
    ].every(Boolean);
    if (!matches) {
      throw unavailable();
    }
    return claim;
  } catch {
    throw unavailable();
  }
};

const assertExpiredRealmReentry = (
  operator: HostedOperatorRecord,
  plan: HostedOperatorPlan,
  expiresAt: string,
) => {
  const preparation = operator.authPreparation;
  const link = operator.identityLink;
  const completed = [
    plan.action === "prepare",
    operator.pendingEffectId === undefined,
    operator.pendingEffectAttempt === undefined,
    operator.receipts.length === plan.effects.length,
    plan.effects.every(
      (effect) =>
        operator.receipts.filter((receipt) => receipt.effectId === effect.id).length === 1,
    ),
    preparation !== undefined,
    preparation?.database === plan.authDatabase.database,
    preparation?.runtimeRole === plan.authDatabase.runtimeRole,
    preparation?.targetDigest === plan.authSchema?.targetDigest,
    link?.expiresAt === expiresAt,
    Date.parse(expiresAt) <= Date.now(),
    link?.consumedAt === undefined,
    link?.proofRef === undefined,
    link?.proofSha256 === undefined,
  ].every(Boolean);
  if (!completed) {
    throw unavailable();
  }
};

const assertRealmEffectRestriction = async (
  deps: HostedOperatorOwnerDependencies,
  input: HostedOperatorContext & { plan: HostedOperatorPlan },
) => {
  const owner = operatorOwnerContextSchema.parse(input.ownerContext);
  const claim = readRealmOwnerRestriction(deps, owner, input.target.appId);
  if (claim === undefined) {
    return;
  }
  if (deps.journal === undefined) {
    throw unavailable();
  }
  const row = await deps.journal.read(input);
  const operator = row?.record.operator;
  const link = operator?.identityLink;
  const matches = [
    operator?.operationRef === claim.operationRef,
    operator?.planDigest === claim.approvedPlanDigest,
    operatorPlanDigest(input.plan) === claim.approvedPlanDigest,
    link?.ownerSessionId === claim.ownerSessionId,
    link?.nonceSha256 === claim.nonceSha256,
  ].every(Boolean);
  if (!matches || operator === undefined || link === undefined) {
    throw unavailable();
  }
  if (claim.reason.kind === "consumed-proof") {
    if (
      link.consumedAt === undefined ||
      link.proofRef !== claim.reason.proofRef ||
      link.proofSha256 !== claim.reason.proofSha256
    ) {
      throw unavailable();
    }
    return;
  }
  assertExpiredRealmReentry(operator, input.plan, claim.reason.expiresAt);
};

const readOwnedState = async (
  deps: HostedOperatorOwnerDependencies,
  owner: OperatorOwnerContext,
  principal: HostedPrincipal,
  selection: OperatorSelection,
) => {
  readRealmOwnerRestriction(deps, owner, selection.appId);
  if (selection.sessionId !== owner.sessionId || selection.environment !== "preview") {
    throw unavailable();
  }
  const { session, sessionVersion } = await readCurrentOwnedSession(deps, principal, owner);
  if (!(await deps.membership.isMember({ principal, workspaceId: owner.authority.workspaceId }))) {
    throw unavailable();
  }
  if (owner.kind === "direct") {
    return await readDirectOwnerTarget(deps, owner, principal, selection, session, sessionVersion);
  }
  return await readHandoffOwnerTarget(deps, owner, principal, selection, session, sessionVersion);
};

/**
 * Server-only delegated authority for the exact Builder workload. The owner tuple
 * is only a lookup hint: every call re-reads the owner-scoped handoff, Eve row,
 * active membership, and Vercel grant before exposing an operator context.
 * Artifact reads recheck canonical ownership independently of provider grants.
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

  const readCurrentPlanningOwner = async (input: HostedOperatorContext) => {
    const owner = operatorOwnerContextSchema.parse(input.ownerContext);
    const { principal } = ownerContextFromHint(owner);
    const current = await readOwnedState(deps, owner, principal, {
      appId: input.target.appId,
      branch: input.target.branch,
      environment: input.target.environment,
      projectId: input.target.projectId,
      sessionId: input.target.sessionId,
    });
    // oxlint-disable-next-line sonarjs/expression-complexity -- Approval is accepted only when every terminal receipt binding matches.
    if (
      !sameAuthority(input.authority, owner.authority) ||
      JSON.stringify(current.target) !== JSON.stringify(input.target) ||
      current.session.adapterGeneration !== owner.adapterGeneration ||
      current.session.adapterSessionId !== owner.adapterSessionId
    ) {
      throw unavailable();
    }
    return current;
  };
  /** Recheck canonical artifact ownership without borrowing deployment authority. */
  const assertArtifactAuthorized = async (input: HostedOperatorContext): Promise<void> => {
    const { owner, principal } = ownerContextFromHint(input.ownerContext);
    readRealmOwnerRestriction(deps, owner, input.target.appId);
    if (
      !sameAuthority(input.authority, owner.authority) ||
      input.target.sessionId !== owner.sessionId
    ) {
      throw unavailable();
    }
    const { session, sessionVersion } = await readCurrentOwnedSession(deps, principal, owner);
    if (
      !(await deps.membership.isMember({ principal, workspaceId: owner.authority.workspaceId }))
    ) {
      throw unavailable();
    }
    if (owner.kind === "direct") {
      assertDirectOwnerIdentity(owner, principal, input.target, session, sessionVersion);
    } else {
      await readHandoffOwnerIdentity(deps, owner, principal, input.target, session, sessionVersion);
    }
  };
  const assertPlanningAuthorized = async (input: HostedOperatorContext): Promise<void> => {
    await readCurrentPlanningOwner(input);
  };
  const assertAuthorized = async (
    input: HostedOperatorContext & { plan: HostedOperatorPlan; purpose?: "planning" },
  ) => {
    if (
      !sameOperatorSelection(input.plan.selection, {
        appId: input.target.appId,
        branch: input.target.branch,
        environment: input.target.environment,
        projectId: input.target.projectId,
        sessionId: input.target.sessionId,
      })
    ) {
      throw unavailable();
    }
    await assertPlanningAuthorized(input);
    if (input.purpose !== "planning") {
      await assertRealmEffectRestriction(deps, input);
    }
  };
  return {
    assertArtifactAuthorized,
    assertAuthorized,
    assertPlanningAuthorized,
    authorize: resolve,
    readCurrentPlanningOwner,
  };
};

const projectSettingsApprovalCheckpoint = (
  record: HostedRuntimeJournalRecord | undefined,
  context: { action: "prepare" | "cleanup"; callId: string; planDigest: string },
) => {
  const retainedProjectSettingsDelivery =
    context.action === "prepare" && record?.operator !== undefined
      ? projectSettingsDeliveryProvenance(record.operator, record.operator.plan)
      : undefined;
  if (
    retainedProjectSettingsDelivery?.planDigest === context.planDigest &&
    retainedProjectSettingsDelivery.approvedByCallId === context.callId
  ) {
    return {
      current: {
        approvalId: retainedProjectSettingsDelivery.approvalId,
        operationRef: retainedProjectSettingsDelivery.operationRef,
        plan: retainedProjectSettingsDelivery.plan,
        planDigest: retainedProjectSettingsDelivery.planDigest,
      },
      retainedPrepare: true,
    };
  }
  return null;
};

const retentionRenewalApprovalCheckpoint = (
  record: HostedRuntimeJournalRecord | undefined,
  context: { action: "prepare" | "cleanup"; callId: string; planDigest: string },
) => {
  const retained =
    context.action === "prepare"
      ? retentionRenewalDeliveryProvenance(record).find(
          (provenance) =>
            provenance.planDigest === context.planDigest &&
            provenance.approvedByCallId === context.callId,
        )
      : undefined;
  return retained === undefined
    ? null
    : {
        current: {
          approvalId: retained.approvalId,
          operationRef: retained.operationRef,
          plan: retained.plan,
          planDigest: retained.planDigest,
        },
        retainedPrepare: true,
      };
};

/** Resolve only the validated READY replacement lineage; the caller still verifies
 * the canonical owner's private terminal receipt against this exact checkpoint. */
const readyReplacementApprovalCheckpoint = (
  record: HostedRuntimeJournalRecord | undefined,
  context: { action: "prepare" | "cleanup"; callId: string; planDigest: string },
) => {
  const current = record?.operator;
  if (context.action !== "prepare" || record === undefined || current === undefined) {
    return null;
  }
  const retained = readyReplacementPriorOperators(record, current.plan).find(
    (prior) =>
      prior.operator.planDigest === context.planDigest &&
      prior.approvedByCallId === context.callId &&
      prior.operator.approvalId !== undefined &&
      prior.operator.operationRef === current.operationRef,
  );
  return retained === undefined ? null : { current: retained.operator, retainedPrepare: true };
};

const accountApprovalCheckpoint = (
  record: HostedRuntimeJournalRecord | undefined,
  context: { action: "prepare" | "cleanup"; callId: string; planDigest: string },
) => {
  const accounts = record?.accountPreparation;
  if (
    context.action !== "prepare" ||
    accounts?.accountPlanDigest !== context.planDigest ||
    accounts.accountApprovedByCallId !== context.callId
  ) {
    return null;
  }
  return {
    current: {
      approvalId: accounts.accountApprovalId,
      operationRef: accounts.accountOperationRef,
      plan: accounts.accountPlan,
      planDigest: accounts.accountPlanDigest,
    },
    retainedPrepare: true,
  };
};

const membershipInspectionApprovalCheckpoint = (
  record: HostedRuntimeJournalRecord | undefined,
  context: { action: "prepare" | "cleanup"; callId: string; planDigest: string },
) => {
  if (context.action !== "prepare" || record?.operator === undefined) {
    return null;
  }
  const retained = matchRetainedMembershipInspectionProvenance(record, record.operator.plan, {
    approvedByCallId: context.callId,
    planDigest: context.planDigest,
  });
  return retained === undefined ? null : { current: retained.operator, retainedPrepare: true };
};

const approvalCheckpoint = (
  record: HostedRuntimeJournalRecord | undefined,
  context: { action: "prepare" | "cleanup"; callId: string; planDigest: string },
) => {
  const account = accountApprovalCheckpoint(record, context);
  if (account !== null) {
    return account;
  }
  const gatewayOriginal =
    context.action === "prepare" && record !== undefined
      ? sharedHostProtectionDeliveryProvenance(record).find(
          (provenance) =>
            provenance.planDigest === context.planDigest &&
            provenance.approvedByCallId === context.callId,
        )
      : undefined;
  if (gatewayOriginal !== undefined) {
    return { current: gatewayOriginal, retainedPrepare: true };
  }
  const retainedSettings = projectSettingsApprovalCheckpoint(record, context);
  if (retainedSettings !== null) {
    return retainedSettings;
  }
  const retainedRenewal = retentionRenewalApprovalCheckpoint(record, context);
  if (retainedRenewal !== null) {
    return retainedRenewal;
  }
  const retainedReady = readyReplacementApprovalCheckpoint(record, context);
  if (retainedReady !== null) {
    return retainedReady;
  }
  const retainedMembership = membershipInspectionApprovalCheckpoint(record, context);
  if (retainedMembership !== null) {
    return retainedMembership;
  }
  const retained = record?.retainedAuth;
  const retainedPrepare =
    context.action === "prepare" &&
    retained?.planDigest === context.planDigest &&
    retained.approvedByCallId === context.callId;
  // Cleanup replaces the current operator plan; the original terminal prepare
  // receipt remains bound to its exact retained plan, call and operation.
  const retainedResult = retainedPrepare
    ? retainedOperatorAuthSchema.safeParse(retained)
    : undefined;
  if (retainedResult?.success === false) {
    throw unavailable();
  }
  return {
    current: retainedResult?.success === true ? retainedResult.data : record?.operator,
    retainedPrepare,
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
    const { current, retainedPrepare } = approvalCheckpoint(row?.record, context);
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
    const readReceipt = async () =>
      await readPrivateHostedApproval({
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
      let observedPublicEventCount = 0;
      const observation = await input.observe({
        adapterSessionId: owner.data.adapterSessionId,
        onEvent: () => {
          observedPublicEventCount += 1;
        },
        onPrivateEvent: recorder.observe,
        principal: owner.data.principal,
        readDeadline: true,
        sessionId: owner.data.sessionId,
      });
      if (observation.publicEventCount !== observedPublicEventCount) {
        throw unavailable();
      }
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
      !retainedPrepare || receipt.requestId === current.approvalId,
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

/** Select only an actual current-owner approval; proposed expiry never extends its authority. */
export const createHostedOperatorReadApprovedPlan =
  (input: {
    eve: Pick<HostedEveStore, "getSession">;
    assertCanonicalOwner: (context: HostedOperatorContext) => Promise<void>;
  }) =>
  async (
    context: HostedOperatorContext & {
      plan: HostedOperatorPlan;
      currentOperation?: { operationRef: string; planDigest: string };
      now: number;
    },
  ) => {
    await input.assertCanonicalOwner(context);
    const owner = operatorOwnerContextSchema.parse(context.ownerContext);
    const { session } = await readCurrentOwnedSession(input, owner.principal, owner);
    if (
      session.adapterSessionId !== owner.adapterSessionId ||
      session.adapterGeneration !== owner.adapterGeneration ||
      !samePrincipal(session.principal, owner.principal)
    ) {
      throw unavailable();
    }
    const receipts = (session.privateApprovalReceipts ?? []).map((value) =>
      privateHostedApprovalReceiptSchema.parse(value),
    );
    const scoped = receipts.filter(
      (receipt) =>
        receipt.toolName === "prepare-app-hosted-runtime" &&
        sameOperatorSelection(receipt.toolInput.plan.selection, context.plan.selection),
    );
    const candidates = scoped
      .filter((receipt) => sameOperatorPlanExceptExpiry(receipt.toolInput.plan, context.plan))
      .toSorted((left, right) => left.sequence - right.sequence);
    const latest = candidates.at(-1);
    if (latest === undefined) {
      return null;
    }
    if (
      latest.outcome !== "approved" ||
      latest.responderPrincipalId !== owner.principal.ownerUserId
    ) {
      throw unavailable();
    }
    if (Date.parse(latest.toolInput.plan.retention.expiresAt) <= context.now) {
      return null;
    }
    const current = context.currentOperation;
    if (
      current !== undefined &&
      current.operationRef !== latest.toolInput.operationRef &&
      scoped.some(
        (receipt) =>
          receipt.outcome === "approved" &&
          receipt.toolInput.operationRef === current.operationRef &&
          receipt.toolInput.planDigest === current.planDigest,
      )
    ) {
      throw new HostedOperatorError("operation_in_progress");
    }
    return {
      operationRef: latest.toolInput.operationRef,
      plan: latest.toolInput.plan,
      planDigest: latest.toolInput.planDigest,
    };
  };
