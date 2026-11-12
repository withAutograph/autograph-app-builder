import { isDeepStrictEqual } from "node:util";
import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";

import {
  exactForwardedSessionAuthority,
  HostedSessionAuthorityError,
} from "../hosted/session-authority";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { TargetIterationChange } from "../repository/target-planning";
import type { ImplementationFile } from "./apply-implementation-files";
import {
  ARRUSTED_PRODUCTION_REPOSITORY,
  createDirectProductionGrant,
  directProductionSchemaChangeSchema,
  directProductionSubjectSchema,
} from "./direct-production-authorization";
import type {
  DirectProductionGrant,
  DirectProductionSubject,
} from "./direct-production-authorization";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { observeMergedAppProduction } from "./app-production-observation";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";
import { ownedDraftPublicationHistory } from "./github-draft-publication-lineage";
import { currentGitHubPrDeliveryAuthorityProjection } from "./github-pr-delivery-authority-state";
import {
  directProductionProgressState,
  recordDirectProductionProgress,
} from "./direct-production-progress";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { repositoryAccessReceiptState } from "./repository-access-state";
import type { RepositoryAccessReceipt } from "./repository-access-state";
import {
  newAppImplementationSchemaKind,
  previewStagedImplementationFiles,
} from "./staged-implementation";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
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

type ProposedWorkflow = Extract<AppBuilderWorkflowState, { proposal: PreparedAppCreation }>;

const freshTemplateSourceKind = "fresh-template";

const authorization = defineState<{
  freshDestination?: FreshTemplateProductionPlan & ProductionDestination;
  authoringPlan?: DirectProductionSubject;
  grant?: DirectProductionGrant;
  revisionAnchor?: { proposalDigest: string; priorGrant: DirectProductionGrant };
  pending: Record<string, DirectProductionGrant>;
}>("autograph-app-builder.direct-production-authorization.v1", () => ({ pending: {} }));

const storageKindForWorkflow = (
  state: ProposedWorkflow,
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
  if (!("proposal" in state) || state.sourceReceipt.sourceKind !== freshTemplateSourceKind) {
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
  state: ProposedWorkflow,
  priorGrant?: DirectProductionGrant,
): ProductionDestination | undefined => {
  const { githubSource } = state;
  const access = repositoryAccessReceiptState.get();
  const destination = verifiedArrustedDestination(access, ctx.session.id);
  if (destination === undefined) {
    return undefined;
  }
  if (githubSource === undefined) {
    if (priorGrant !== undefined) {
      return state.sourceReceipt.sourceKind === freshTemplateSourceKind ? destination : undefined;
    }
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

/** A retained predecessor keeps this revision bound after its new grant replaces the live grant. */
const revisionPredecessor = (proposalDigest: string): DirectProductionGrant | undefined => {
  const { grant, revisionAnchor } = authorization.get();
  if (grant === undefined) {
    return undefined;
  }
  if (grant.subject.proposalDigest === proposalDigest) {
    const { revision } = grant.subject;
    return revisionAnchor?.proposalDigest === proposalDigest &&
      revision?.priorGrantDigest === revisionAnchor.priorGrant.digest &&
      revision.priorProposalDigest === revisionAnchor.priorGrant.subject.proposalDigest
      ? revisionAnchor.priorGrant
      : undefined;
  }
  const progress = directProductionProgressState.get();
  return progress?.stage === "live" && progress.grantDigest === grant.digest ? grant : undefined;
};

const isExistingPresentationEdit = (change: TargetIterationChange, appPath: string): boolean => {
  const { before, after, path } = change;
  if (
    before === undefined ||
    after === undefined ||
    before.mode !== after.mode ||
    !path.startsWith(`${appPath}/`)
  ) {
    return false;
  }
  const relative = path.slice(appPath.length + 1);
  return (
    !relative.split("/").some((part) => part.startsWith(".") || part === "schema") &&
    /\.(?:[jt]sx|css)$/u.test(relative) &&
    !/(?:^|\/)(?:layout|route|middleware|proxy)\.[jt]sx$/u.test(relative)
  );
};

const isOwnedAppSourceEdit = (change: TargetIterationChange, appPath: string): boolean => {
  if (isExistingPresentationEdit(change, appPath)) {
    return true;
  }
  const { path, before, after } = change;
  if (after === undefined || (before?.mode ?? "644") !== after.mode) {
    return false;
  }
  const relative = path.slice(appPath.length + 1);
  const appSource =
    path.startsWith(`${appPath}/`) &&
    /^(?:src\/)?(?:app|components|lib)\/.+\.(?:[jt]sx?|css)$/u.test(relative) &&
    !relative.split("/").some((part) => part.startsWith(".") || part === "schema");
  const routeFile = /(?:^|\/)(?:layout|route|middleware|proxy)\.[jt]sx?$/u.test(relative);
  const newEntry =
    before === undefined &&
    /(?:^|\/)(?:page|template|loading|not-found|error|global-error|default)\.[jt]sx?$/u.test(
      relative,
    );
  return appSource && !routeFile && !newEntry;
};

const isSourceOnlyRevisionEdit = (change: TargetIterationChange, appPath: string): boolean => {
  const { path, before, after } = change;
  if (
    before === undefined ||
    after === undefined ||
    before.mode !== after.mode ||
    !path.startsWith(`${appPath}/`)
  ) {
    return false;
  }
  const relative = path.slice(appPath.length + 1);
  const runtimeBinding = /^(?:src\/)?app\/data\/(?:context|protected-config)\.[jt]sx?$/u.test(
    relative,
  );
  const configuration = /\.config\.[jt]sx?$/u.test(relative);
  const testSource =
    /^tests\/.+\.[jt]sx?$/u.test(relative) &&
    !relative.split("/").some((part) => part.startsWith(".") || part === "schema");
  return !runtimeBinding && !configuration && (isOwnedAppSourceEdit(change, appPath) || testSource);
};

type RevisionScope = Pick<NonNullable<DirectProductionSubject["revision"]>, "schemaChange">;

/** The schema compiler and protected installer independently verify the effect of these exact bytes. */
const schemaRevisionScope = (
  changes: readonly TargetIterationChange[],
  appPath: string,
  cuePath: string,
): RevisionScope | undefined => {
  const cueChanges = changes.filter(({ path }) => path === cuePath);
  const [cue] = cueChanges;
  if (cue === undefined || cueChanges.length !== 1) {
    return undefined;
  }
  const { before: priorCue, after: candidateCue } = cue;
  if (priorCue === undefined || candidateCue === undefined || priorCue.mode !== candidateCue.mode) {
    return undefined;
  }
  if (
    priorCue.digest === candidateCue.digest ||
    candidateCue.digest !== sha256(candidateCue.content)
  ) {
    return undefined;
  }
  if (!changes.every((change) => change === cue || isOwnedAppSourceEdit(change, appPath))) {
    return undefined;
  }
  const schemaChange = directProductionSchemaChangeSchema.safeParse({
    kind: "add-optional-text-field",
    priorCueSha256: priorCue.digest,
    candidateCueSha256: candidateCue.digest,
  });
  return schemaChange.success ? { schemaChange: schemaChange.data } : undefined;
};

/** Repeated tool input cannot add a write outside the already frozen app proposal. */
const onlyFrozenRevisionRepeats = (
  changes: readonly TargetIterationChange[],
  submitted: readonly ImplementationFile[],
  staged: readonly ImplementationFile[],
): boolean => {
  if (submitted.length === 0 && staged.length === 0) {
    return true;
  }
  const frozen = new Map(changes.map((change) => [change.path, change]));
  if (frozen.size !== changes.length) {
    return false;
  }
  const matches = (file: ImplementationFile) => {
    const change = frozen.get(file.path);
    if (change === undefined) {
      return false;
    }
    return file.operation === "delete"
      ? change.after === undefined
      : change.after !== undefined && change.after.content === file.content;
  };
  return submitted.every(matches) && staged.every(matches);
};

const eligibleRevisionScope = (
  state: ProposedWorkflow,
  implementationFiles: readonly ImplementationFile[],
): RevisionScope | undefined => {
  const { appSpec, proposal } = state;
  const { target } = proposal;
  if (
    !("operation" in target) ||
    target.frameworkUpgrade !== undefined ||
    target.applicationSourceImport !== undefined
  ) {
    return undefined;
  }
  const appPath = `apps/${appSpec.appId}`;
  const { changes } = target.iteration;
  if (target.plan.source.workspacePath !== appPath || changes.length === 0) {
    return undefined;
  }
  const stagedFiles = previewStagedImplementationFiles({
    appSpecDigest: appSpec.digest,
    files: [],
    proposalDigest: proposal.digest,
  });
  if (!onlyFrozenRevisionRepeats(changes, implementationFiles, stagedFiles)) {
    return undefined;
  }
  if (changes.every((change) => isSourceOnlyRevisionEdit(change, appPath))) {
    return {};
  }
  const { schema } = target.plan.source;
  const cuePath = `${appPath}/schema/${appSpec.appId}.cue`;
  return schema.kind === "kernel" && schema.path === cuePath
    ? schemaRevisionScope(changes, appPath, cuePath)
    : undefined;
};

const matchesRevisionPredecessor = (
  subject: DirectProductionSubject,
  prior: DirectProductionSubject,
): boolean =>
  [
    subject.appId === prior.appId,
    subject.sessionId === prior.sessionId,
    subject.buildWorkspaceId === prior.buildWorkspaceId,
    isDeepStrictEqual(subject.authority, prior.authority),
    subject.repositoryId === prior.repositoryId,
    subject.repositoryFullName === prior.repositoryFullName,
    subject.installationId === prior.installationId,
    subject.baseBranch === prior.baseBranch,
    subject.storageKind === prior.storageKind,
  ].every(Boolean);

const subjectForProposal = (
  ctx: OwnerContext,
  state: ProposedWorkflow,
  implementationFiles: readonly ImplementationFile[],
  priorGrant?: DirectProductionGrant,
): DirectProductionSubject | undefined => {
  const { appSpec, proposal, workspace } = state;
  const { target } = proposal;
  if ((appSpec.access?.mode ?? "private") !== "private") {
    return undefined;
  }
  const scope =
    priorGrant === undefined ? undefined : eligibleRevisionScope(state, implementationFiles);
  if ("operation" in target && scope === undefined) {
    return undefined;
  }
  const destination = productionDestinationForPlan(ctx, state, priorGrant);
  if (destination === undefined) {
    return undefined;
  }
  const execution = hostedOperatorCallbackExecution(ctx.session);
  const identity = exactForwardedSessionAuthority(ctx.session.auth, {
    realmContinuation: { adapterSessionId: execution.ownerAnchorRunId ?? ctx.session.id },
  });
  const revision =
    priorGrant === undefined
      ? {}
      : {
          revision: {
            priorGrantDigest: priorGrant.digest,
            priorProposalDigest: priorGrant.subject.proposalDigest,
            ...scope,
          },
        };
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
    ...revision,
  });
  if (!subject.success) {
    return undefined;
  }
  return priorGrant === undefined || matchesRevisionPredecessor(subject.data, priorGrant.subject)
    ? subject.data
    : undefined;
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
  const predecessor =
    "operation" in state.proposal.target ? revisionPredecessor(state.proposal.digest) : undefined;
  return subjectForProposal(ctx, state, implementationFiles, predecessor);
};

const sameSubject = (first: DirectProductionSubject | undefined, second: DirectProductionSubject) =>
  isDeepStrictEqual(first, second);

interface RevisionObservationPorts {
  publication?: (
    auth: ToolContext["session"]["auth"],
    options: { selectedInstallationId: string },
  ) => Promise<Pick<GitHubPublicationRuntime, "inspectPublishedPullRequest">>;
  observeProduction?: typeof observeMergedAppProduction;
}

const priorRevisionDelivery = (state: ProposedWorkflow, priorGrant: DirectProductionGrant) => {
  const prior = priorGrant.subject;
  const [owner = "", name = ""] = prior.repositoryFullName.split("/");
  const history = ownedDraftPublicationHistory({
    sessionId: prior.sessionId,
    appId: prior.appId,
    repositoryId: prior.repositoryId,
    owner,
    name,
  });
  const priorDraft = state.publishedGitHubDraftProposalDigest;
  const knownProposals = new Set<string>();
  for (const { installationId, proposal } of history) {
    if (installationId === prior.installationId && proposal.baseBranch === prior.baseBranch) {
      knownProposals.add(proposal.digest);
    }
  }
  if (state.sourceReceipt.sourceKind === freshTemplateSourceKind && priorDraft !== undefined) {
    knownProposals.add(priorDraft);
  }
  const { calls } = currentGitHubPrDeliveryAuthorityProjection();
  const delivery = calls.findLast((call) =>
    [
      call.cancelled !== true,
      call.directProductionGrantDigest === priorGrant.digest,
      call.subject.appId === prior.appId,
      call.subject.appSpecDigest === prior.appSpecDigest,
      call.subject.installationId === prior.installationId,
      call.subject.reconciliationDigest === undefined,
      knownProposals.has(call.subject.proposalDigest),
    ].every(Boolean),
  );
  return delivery === undefined ? undefined : { delivery, owner, name };
};

/** Restore a lost live observation through the original approved delivery and current provider readback. */
export const restoreDirectProductionRevisionPredecessor = async (
  ctx: ToolContext,
  ports: RevisionObservationPorts = {},
): Promise<void> => {
  ctx.abortSignal.throwIfAborted();
  const state = appBuilderWorkflowState.get();
  if (state.phase !== "planned" || eligibleRevisionScope(state, []) === undefined) {
    return;
  }
  const { grant } = authorization.get();
  if (
    grant === undefined ||
    grant.subject.proposalDigest === state.proposal.digest ||
    revisionPredecessor(state.proposal.digest) !== undefined
  ) {
    return;
  }
  const subject = subjectForProposal(ctx, state, [], grant);
  const priorDelivery = subject === undefined ? undefined : priorRevisionDelivery(state, grant);
  if (subject === undefined || priorDelivery === undefined) {
    return;
  }
  const isCurrent = () => {
    ctx.abortSignal.throwIfAborted();
    return (
      isDeepStrictEqual(appBuilderWorkflowState.get(), state) &&
      isDeepStrictEqual(authorization.get().grant, grant) &&
      isDeepStrictEqual(priorRevisionDelivery(state, grant), priorDelivery) &&
      sameSubject(subjectForProposal(ctx, state, [], grant), subject)
    );
  };
  const { delivery, owner, name } = priorDelivery;
  try {
    const runtime = await (ports.publication ?? githubPublicationRuntimeForSession)(
      ctx.session.auth,
      {
        selectedInstallationId: subject.installationId,
      },
    );
    if (!isCurrent()) {
      return;
    }
    const observed = await runtime.inspectPublishedPullRequest?.(delivery.subject.proposalDigest);
    if (
      !isCurrent() ||
      observed?.state !== "merged" ||
      observed.mergeCommitSha === undefined ||
      !observed.reviewedRevision
    ) {
      return;
    }
    const target = observed.reviewedTarget;
    if (
      ![
        target.repositoryId === subject.repositoryId,
        target.owner === owner,
        target.name === name,
        target.baseBranch === subject.baseBranch,
      ].every(Boolean)
    ) {
      return;
    }
    const live = await (ports.observeProduction ?? observeMergedAppProduction)(
      {
        appId: subject.appId,
        repositoryId: subject.repositoryId,
        repositoryFullName: subject.repositoryFullName,
      },
      ctx,
      observed.mergeCommitSha,
    );
    if (!isCurrent() || live.status !== "available") {
      return;
    }
    if (
      [
        live.requestedRevision === "live",
        live.appId === subject.appId,
        live.destination?.repositoryId === subject.repositoryId,
        live.destination?.repositoryFullName === subject.repositoryFullName,
      ].every(Boolean)
    ) {
      recordDirectProductionProgress(grant.digest, "live");
    }
  } catch {
    // Missing provider evidence cannot restore the previous live grant.
    ctx.abortSignal.throwIfAborted();
  }
};

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
  const priorGrant =
    subject.revision === undefined ? undefined : revisionPredecessor(subject.proposalDigest);
  if (subject.revision !== undefined && priorGrant?.digest !== subject.revision.priorGrantDigest) {
    throw new Error(
      "The revision no longer belongs to the app’s previously confirmed Production release.",
    );
  }
  const revisionAnchor =
    priorGrant === undefined ? undefined : { proposalDigest: subject.proposalDigest, priorGrant };
  authorization.update((current) => ({
    ...current,
    grant: pending,
    pending: remaining,
    revisionAnchor,
  }));
  return pending;
};
