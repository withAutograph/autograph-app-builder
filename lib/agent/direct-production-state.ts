import { isDeepStrictEqual } from "node:util";
import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";

import {
  exactForwardedSessionAuthority,
  HostedSessionAuthorityError,
} from "../hosted/session-authority";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { ImplementationFile } from "./apply-implementation-files";
import {
  ARRUSTED_PRODUCTION_REPOSITORY,
  createDirectProductionGrant,
  directProductionSubjectSchema,
} from "./direct-production-authorization";
import type {
  DirectProductionGrant,
  DirectProductionSubject,
} from "./direct-production-authorization";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { repositoryAccessReceiptState } from "./repository-access-state";
import type { RepositoryAccessReceipt } from "./repository-access-state";
import {
  newAppImplementationSchemaKind,
  previewStagedImplementationFiles,
} from "./staged-implementation";
import { appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState, PreparedAppCreation } from "./workflow-state";

type OwnerContext = Pick<ToolContext, "session">;
type GrantRequest = Pick<DirectProductionGrant, "callId" | "subject"> &
  (
    | { toolName: "apply_app_creation"; implementationFiles: readonly ImplementationFile[] }
    | { toolName: "release-app-production"; implementationFiles?: never }
  );
type SubjectMatch = Pick<DirectProductionSubject, "appId"> &
  Partial<Pick<DirectProductionSubject, "repositoryId" | "baseBranch" | "installationId">> & {
    repositoryFullName?: string;
  };

type FreshTemplateProductionPlan = Pick<
  DirectProductionSubject,
  "appId" | "appSpecDigest" | "proposalDigest" | "sessionId" | "buildWorkspaceId"
>;
type ProductionDestination = Pick<
  DirectProductionSubject,
  "repositoryId" | "repositoryFullName" | "installationId" | "baseBranch"
>;

const authorization = defineState<{
  freshDestination?: FreshTemplateProductionPlan & ProductionDestination;
  authoringPlan?: DirectProductionSubject;
  grant?: DirectProductionGrant;
  pending: Record<string, DirectProductionGrant>;
}>("autograph-app-builder.direct-production-authorization.v1", () => ({ pending: {} }));

const storageKindForWorkflow = (
  state: Extract<AppBuilderWorkflowState, { proposal: PreparedAppCreation }>,
  sourceKind: "kernel" | "none",
  implementationFiles: readonly ImplementationFile[],
): DirectProductionSubject["storageKind"] => {
  if ("appBackendKind" in state && state.appBackendKind !== undefined) {
    return state.appBackendKind === "generated-postgres" ? "postgres" : "none";
  }
  if ("applyReceipt" in state) {
    const { schemaCuePath } = state.identityReceipt.identity;
    const appliedSchema = state.applyReceipt.postTree.some((file) => file.path === schemaCuePath);
    return appliedSchema ? "postgres" : "none";
  }
  const { appSpec, proposal } = state;
  const files = previewStagedImplementationFiles({
    appSpecDigest: appSpec.digest,
    files: implementationFiles,
    proposalDigest: proposal.digest,
  });
  return newAppImplementationSchemaKind(
    appSpec.appId,
    sourceKind,
    files,
    proposal.target.plan.source.workspacePath,
  ) === "kernel"
    ? "postgres"
    : "none";
};

const verifiedArrustedDestination = (
  access: RepositoryAccessReceipt | undefined,
  sessionId: string,
): ProductionDestination | undefined => {
  if (
    access?.sessionId !== sessionId ||
    `${access.repository.owner}/${access.repository.name}` !== ARRUSTED_PRODUCTION_REPOSITORY
  ) {
    return undefined;
  }
  return {
    repositoryId: access.repository.repositoryId,
    repositoryFullName: ARRUSTED_PRODUCTION_REPOSITORY,
    installationId: access.scope.installationId,
    baseBranch: access.repository.defaultBranch,
  };
};

/** Capture the exact private starter plan before obtaining external destination readback. */
export const freshTemplateProductionPlan = (
  ctx: OwnerContext,
): FreshTemplateProductionPlan | undefined => {
  const state = appBuilderWorkflowState.get();
  if (!("proposal" in state) || state.sourceReceipt.sourceKind !== "fresh-template") {
    return undefined;
  }
  if (
    state.githubSource !== undefined ||
    "operation" in state.proposal.target ||
    (state.appSpec.access?.mode ?? "private") !== "private"
  ) {
    return undefined;
  }
  return {
    appId: state.appSpec.appId,
    appSpecDigest: state.appSpec.digest,
    proposalDigest: state.proposal.digest,
    sessionId: ctx.session.id,
    buildWorkspaceId: state.workspace.workspaceId,
  };
};

export const recordFreshTemplateProductionDestination = (
  ctx: OwnerContext,
  plan: FreshTemplateProductionPlan,
  access: RepositoryAccessReceipt,
): void => {
  const destination = verifiedArrustedDestination(access, ctx.session.id);
  if (destination === undefined || !isDeepStrictEqual(freshTemplateProductionPlan(ctx), plan)) {
    throw new Error("The app or verified Arrusted destination changed during release preparation.");
  }
  const selected = { ...plan, ...destination };
  authorization.update((state) => ({
    ...state,
    freshDestination: selected,
  }));
};

const productionDestinationForPlan = (
  ctx: OwnerContext,
  githubSource: Extract<AppBuilderWorkflowState, { proposal: PreparedAppCreation }>["githubSource"],
): ProductionDestination | undefined => {
  const access = repositoryAccessReceiptState.get();
  const destination = verifiedArrustedDestination(access, ctx.session.id);
  if (destination === undefined) {
    return undefined;
  }
  if (githubSource === undefined) {
    const plan = freshTemplateProductionPlan(ctx);
    return plan !== undefined &&
      isDeepStrictEqual(authorization.get().freshDestination, { ...plan, ...destination })
      ? destination
      : undefined;
  }
  const { repository } = githubSource;
  const matches = [
    repository.repositoryId === destination.repositoryId,
    repository.defaultBranch === destination.baseBranch,
    `${repository.owner}/${repository.name}` === destination.repositoryFullName,
    githubSource.resolvedRef === `refs/heads/${repository.defaultBranch}`,
  ].every(Boolean);
  return matches ? destination : undefined;
};

/** Derive the reviewable scope from the owner's accepted private plan and verified repository. */
export const directProductionSubjectForPlan = (
  ctx: OwnerContext,
  implementationFiles: readonly ImplementationFile[] = [],
): DirectProductionSubject | undefined => {
  const state = appBuilderWorkflowState.get();
  if (!("proposal" in state)) {
    return undefined;
  }
  const { githubSource, appSpec, proposal, workspace } = state;
  const { target } = proposal;
  if ("operation" in target || (appSpec.access?.mode ?? "private") !== "private") {
    return undefined;
  }
  const destination = productionDestinationForPlan(ctx, githubSource);
  if (destination === undefined) {
    return undefined;
  }
  const execution = hostedOperatorCallbackExecution(ctx.session);
  const identity = exactForwardedSessionAuthority(ctx.session.auth, {
    realmContinuation: { adapterSessionId: execution.ownerAnchorRunId ?? ctx.session.id },
  });
  const subject = directProductionSubjectSchema.safeParse({
    version: 1,
    appId: appSpec.appId,
    appSpecDigest: appSpec.digest,
    proposalDigest: proposal.digest,
    sessionId: ctx.session.id,
    buildWorkspaceId: workspace.workspaceId,
    authority: identity.authority,
    ...destination,
    storageKind: storageKindForWorkflow(state, target.plan.source.schema.kind, implementationFiles),
  });
  return subject.success ? subject.data : undefined;
};

const sameSubject = (first: DirectProductionSubject | undefined, second: DirectProductionSubject) =>
  isDeepStrictEqual(first, second);

/** A successful preflight permits drafting to continue for the exact plan, without granting Build. */
export const recordPlannedDirectProductionAuthoring = (subject: DirectProductionSubject): void => {
  if (appBuilderWorkflowState.get().phase === "planned") {
    authorization.update((state) => ({ ...state, authoringPlan: subject }));
  }
};

export const currentPlannedDirectProductionAuthoring = (ctx: OwnerContext): string | undefined => {
  const { authoringPlan } = authorization.get();
  if (authoringPlan === undefined || appBuilderWorkflowState.get().phase !== "planned") {
    return undefined;
  }
  let current: DirectProductionSubject | undefined;
  try {
    current = directProductionSubjectForPlan(ctx);
  } catch (error) {
    if (error instanceof HostedSessionAuthorityError) {
      return undefined;
    }
    throw error;
  }
  if (
    current === undefined ||
    !sameSubject({ ...current, storageKind: authoringPlan.storageKind }, authoringPlan)
  ) {
    return undefined;
  }
  const { grant, terminalDecisions } = readPrivateApplyAuthority();
  const { proposalDigest, sessionId } = current;
  if (
    (grant?.proposalDigest === proposalDigest && grant.sessionId === sessionId) ||
    terminalDecisions?.some(
      ({ scope }) => scope.proposalDigest === proposalDigest && scope.sessionId === sessionId,
    ) === true
  ) {
    return undefined;
  }
  return proposalDigest;
};

export const currentDirectProductionGrant = (
  ctx: OwnerContext,
  match: SubjectMatch,
): DirectProductionGrant | undefined => {
  const { grant } = authorization.get();
  if (grant === undefined || grant.subject.appId !== match.appId) {
    return undefined;
  }
  const { subject } = grant;
  const matchesDestination = (
    ["repositoryId", "repositoryFullName", "baseBranch", "installationId"] as const
  ).every((key) => match[key] === undefined || match[key] === subject[key]);
  if (!matchesDestination || !sameSubject(directProductionSubjectForPlan(ctx), subject)) {
    return undefined;
  }
  return grant;
};

export const requestDirectProductionGrant = (
  ctx: OwnerContext,
  input: GrantRequest,
): "approved" | "user-approval" => {
  const { callId, implementationFiles, subject, toolName } = input;
  if (!sameSubject(directProductionSubjectForPlan(ctx, implementationFiles), subject)) {
    throw new Error(
      "Review the current app and Arrusted destination before approving Production delivery.",
    );
  }
  const { grant } = authorization.get();
  if (sameSubject(grant?.subject, subject)) {
    return "approved";
  }
  const next = createDirectProductionGrant({ callId, subject, toolName });
  authorization.update((state) => {
    const prior = state.pending[callId];
    if (prior !== undefined && prior.digest !== next.digest) {
      throw new Error("The pending Production approval belongs to a different release.");
    }
    return { ...state, pending: { ...state.pending, [callId]: next } };
  });
  return "user-approval";
};

/** Call only from actual execution after Eve settles the approval on this call. */
export const recordDirectProductionGrant = (
  ctx: OwnerContext,
  input: GrantRequest,
): DirectProductionGrant => {
  const { callId, implementationFiles, subject, toolName } = input;
  if (!sameSubject(directProductionSubjectForPlan(ctx, implementationFiles), subject)) {
    throw new Error("The app or Arrusted destination changed after the Production approval.");
  }
  const state = authorization.get();
  if (state.grant !== undefined && sameSubject(state.grant.subject, subject)) {
    return state.grant;
  }
  const expected = createDirectProductionGrant({ callId, subject, toolName });
  const pending = state.pending[callId];
  if (pending?.digest !== expected.digest) {
    throw new Error("The current call has no matching Production approval.");
  }
  const remaining = Object.fromEntries(
    Object.entries(state.pending).filter(([id]) => id !== callId),
  );
  authorization.update((current) => ({ ...current, grant: pending, pending: remaining }));
  return pending;
};
