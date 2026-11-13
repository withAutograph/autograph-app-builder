import { isDeepStrictEqual } from "node:util";
import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";

import {
  exactForwardedSessionAuthority,
  HostedSessionAuthorityError,
} from "../hosted/session-authority";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import type { OverlayChange } from "../repository/target-apply";
import type { TargetIterationChange } from "../repository/target-planning";
import type { ImplementationFile } from "./apply-implementation-files";
import { approvalReceiptForExistingDraftUpdate } from "./approval-receipt";
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
  draftReconciliationCompletions,
  draftReconciliationState,
} from "./draft-reconciliation-state";
import { currentDraftCandidateSource } from "./published-draft-repair";
import {
  directProductionProgressState,
  directProductionDeliverySettled,
  hasAvailableDirectProductionPredecessor,
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
  reconciliation?: { failedGrantDigest: string; subject: DirectProductionSubject } | null;
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
  return hasAvailableDirectProductionPredecessor(progress?.stage) &&
    progress?.grantDigest === grant.digest
    ? grant
    : undefined;
};

type AppFileChange = Pick<OverlayChange, "path" | "before" | "after">;

const isExistingPresentationEdit = (change: AppFileChange, appPath: string): boolean => {
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

const isOwnedAppSourceEdit = (change: AppFileChange, appPath: string): boolean => {
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

const isSourceOnlyRevisionEdit = (change: AppFileChange, appPath: string): boolean => {
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

const reviewedDraftReconciliation = (state: ProposedWorkflow) => {
  const candidate = draftReconciliationState.get();
  const proposal = candidate?.proposal;
  if (state.phase !== "reviewed" || candidate === null) {
    return null;
  }
  const originPublicationDigest =
    candidate.publishedOrigin?.publicationProposalDigest ??
    candidate.publicationScope?.proposal.digest ??
    state.publishedGitHubDraftProposalDigest ??
    state.githubDraftProposal?.proposal.digest;
  const matches = [
    candidate.kind !== "published-draft-repair",
    candidate.appId === state.appSpec.appId,
    candidate.originalReviewDigest === state.reviewReceipt?.digest,
    originPublicationDigest !== undefined,
  ].every(Boolean);
  return matches && originPublicationDigest !== undefined
    ? { candidate, proposal, originPublicationDigest }
    : null;
};

const candidateReviewMismatch = "candidate-review-mismatch";
const approvedReleaseMismatch = "approved-release-mismatch";
const readAnchoredMerge = "read-anchored-merge";

type ReconciliationCandidateFailure =
  | "candidate-unsealed"
  | "candidate-compile-unavailable"
  | typeof candidateReviewMismatch
  | "schema-predecessor-mismatch"
  | "candidate-file-scope"
  | "candidate-schema-unchanged";

const directDraftReconciliationScope = (
  state: ProposedWorkflow,
  subject: DirectProductionSubject,
  failedGrant: DirectProductionGrant,
  onFailure?: (reason: ReconciliationCandidateFailure) => void,
) => {
  const reviewBinding = reviewedDraftReconciliation(state);
  const { revision } = subject;
  const previous = failedGrant.subject.revision;
  if (
    reviewBinding === null ||
    revision?.schemaChange === undefined ||
    previous?.schemaChange === undefined
  ) {
    onFailure?.(candidateReviewMismatch);
    return null;
  }
  if (
    failedGrant.subject.proposalDigest !== subject.proposalDigest ||
    failedGrant.subject.appSpecDigest !== subject.appSpecDigest ||
    !matchesRevisionPredecessor(subject, failedGrant.subject)
  ) {
    onFailure?.(candidateReviewMismatch);
    return null;
  }
  const { candidate, proposal, originPublicationDigest } = reviewBinding;
  if (proposal === undefined) {
    onFailure?.("candidate-unsealed");
    return null;
  }
  const completion = draftReconciliationCompletions
    .get()
    .find(({ proposal: retained }) => isDeepStrictEqual(retained, proposal));
  const compilation = candidate.validation?.compilation;
  if (completion?.preparation !== "sealed-before-approval") {
    onFailure?.("candidate-unsealed");
    return null;
  }
  if (
    compilation?.release.status !== "published" ||
    !isDeepStrictEqual(compilation, completion.compilation)
  ) {
    onFailure?.("candidate-compile-unavailable");
    return null;
  }
  const reviewCurrent = [
    proposal.returnToDraft !== true,
    candidate.conflicts.length === 0,
    candidate.dependencyCatalog === undefined,
    isDeepStrictEqual(candidate.review, completion.review),
  ].every(Boolean);
  if (!reviewCurrent || currentDraftCandidateSource(state, candidate) === undefined) {
    onFailure?.(candidateReviewMismatch);
    return null;
  }
  const { review, appReview } = completion;
  const { selection } = compilation.release;
  const matches = [
    completion.appId === subject.appId,
    completion.githubSourceDigest === candidate.githubSourceDigest,
    completion.root === candidate.root,
    appReview.appSpecDigest === subject.appSpecDigest,
    appReview.digest === candidate.originalReviewDigest,
    review.dependencyCatalog === undefined,
    review.appId === subject.appId,
    review.digest === proposal.reviewDigest,
    review.resolvedTree === proposal.resolvedTree,
    candidate.validation?.resolvedTree === proposal.resolvedTree,
    candidate.repositoryId === subject.repositoryId,
    proposal.repositoryId === subject.repositoryId,
    `${proposal.owner}/${proposal.name}` === subject.repositoryFullName,
    proposal.baseBranch === subject.baseBranch,
    candidate.pullRequestNumber === proposal.pullRequestNumber,
    candidate.headSha === proposal.expectedHeadSha,
    candidate.headTree === proposal.expectedHeadTree,
    candidate.baseSha === proposal.expectedBaseSha,
    candidate.baseTree === proposal.expectedBaseTree,
    selection.appId === subject.appId,
    selection.appSpecDigest === subject.appSpecDigest,
    previous.priorGrantDigest === revision.priorGrantDigest,
    previous.priorProposalDigest === revision.priorProposalDigest,
    previous.schemaChange.priorCueSha256 === revision.schemaChange.priorCueSha256,
  ].every(Boolean);
  if (!matches) {
    onFailure?.(candidateReviewMismatch);
    return null;
  }
  const appPath = `apps/${subject.appId}`;
  const cuePath = `${appPath}/schema/${subject.appId}.cue`;
  const releasePath = `${appPath}/schema/release/${selection.releaseId}`;
  const generated = new Set([
    `${appPath}/schema/index.ts`,
    ...GENERATED_RELEASE_MEMBERS.map((member) => `${releasePath}/${member}`),
  ]);
  const cue = review.baseChanges.find(({ path }) => path === cuePath);
  const candidateCueSha256 = cue?.after?.digest;
  const correctBase =
    cue?.before?.digest === revision.schemaChange.priorCueSha256 &&
    cue.before.mode === cue.after?.mode;
  const sameFileScope = review.baseChanges.every((change) => {
    const mode = change.after?.mode;
    const unchangedMode = mode === change.before?.mode;
    const ordinaryNewFile = change.before === undefined && (mode === "644" || mode === "100644");
    if (mode === undefined || !(unchangedMode || ordinaryNewFile)) {
      return false;
    }
    return (
      change === cue || generated.has(change.path) || isSourceOnlyRevisionEdit(change, appPath)
    );
  });
  const correctedBytes =
    candidateCueSha256 !== undefined &&
    candidateCueSha256 !== revision.schemaChange.candidateCueSha256 &&
    candidateCueSha256 !== revision.schemaChange.priorCueSha256;
  if (!correctBase) {
    onFailure?.("schema-predecessor-mismatch");
    return null;
  }
  if (!sameFileScope) {
    onFailure?.("candidate-file-scope");
    return null;
  }
  if (!correctedBytes) {
    onFailure?.("candidate-schema-unchanged");
    return null;
  }
  const corrected = directProductionSubjectSchema.safeParse({
    ...subject,
    revision: {
      ...revision,
      schemaChange: { ...revision.schemaChange, candidateCueSha256 },
      reconciliation: {
        digest: proposal.digest,
        originPublicationDigest,
        originPublicationReceiptDigest: proposal.priorPublicationDigest,
        pullRequestNumber: proposal.pullRequestNumber,
        expectedHeadSha: proposal.expectedHeadSha,
        expectedBaseSha: proposal.expectedBaseSha,
        resolvedTree: proposal.resolvedTree,
        reviewDigest: review.digest,
      },
    },
  });
  if (!corrected.success) {
    onFailure?.(candidateReviewMismatch);
    return null;
  }
  return { subject: corrected.data, proposal, originPublicationDigest };
};

const sameSubject = (first: DirectProductionSubject | undefined, second: DirectProductionSubject) =>
  isDeepStrictEqual(first, second);

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
  const subject = subjectForProposal(ctx, state, implementationFiles, predecessor);
  const { grant, reconciliation } = authorization.get();
  if (
    subject?.revision?.schemaChange === undefined ||
    grant?.subject.proposalDigest !== subject.proposalDigest
  ) {
    return subject;
  }
  if (reviewedDraftReconciliation(state) === null) {
    return grant.subject.revision?.reconciliation === undefined ? subject : undefined;
  }
  const draft = directDraftReconciliationScope(state, subject, grant);
  if (
    draft === null ||
    !sameSubject(reconciliation?.subject, draft.subject) ||
    (reconciliation?.failedGrantDigest !== grant.digest &&
      !sameSubject(grant.subject, draft.subject))
  ) {
    return undefined;
  }
  return draft.subject;
};

interface RevisionObservationPorts {
  publication?: (
    auth: ToolContext["session"]["auth"],
    options: { selectedInstallationId: string },
  ) => Promise<
    Pick<
      GitHubPublicationRuntime,
      "inspectPublishedPullRequest" | "inspectPublishedReconciliationHead"
    >
  >;
  observeProduction?: typeof observeMergedAppProduction;
}

const priorRevisionDelivery = (
  state: ProposedWorkflow,
  priorGrant: DirectProductionGrant,
  purpose: "restore-predecessor" | typeof readAnchoredMerge = "restore-predecessor",
) => {
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
  const marker = prior.revision?.reconciliation;
  const delivery = calls.findLast((call) =>
    [
      call.cancelled !== true || purpose === readAnchoredMerge,
      call.directProductionGrantDigest === priorGrant.digest,
      call.subject.appId === prior.appId,
      call.subject.appSpecDigest === prior.appSpecDigest,
      call.subject.installationId === prior.installationId,
      call.subject.reconciliationDigest === marker?.digest,
      knownProposals.has(call.subject.proposalDigest),
    ].every(Boolean),
  );
  if (delivery === undefined) {
    return null;
  }
  if (marker === undefined) {
    return { delivery, owner, name };
  }
  const completion = draftReconciliationCompletions
    .get()
    .find(
      ({ proposal, preparation }) =>
        preparation === "sealed-before-approval" && proposal.digest === marker.digest,
    );
  const reconcile = completion?.proposal;
  if (
    reconcile === undefined ||
    ![
      delivery.subject.proposalDigest === marker.originPublicationDigest,
      reconcile.priorPublicationDigest === marker.originPublicationReceiptDigest,
      reconcile.pullRequestNumber === marker.pullRequestNumber,
      reconcile.resolvedTree === marker.resolvedTree,
      reconcile.reviewDigest === marker.reviewDigest,
    ].every(Boolean)
  ) {
    return null;
  }
  return { delivery, owner, name, reconcile };
};

const observePriorRevisionPullRequest = async (
  runtime: Awaited<ReturnType<NonNullable<RevisionObservationPorts["publication"]>>>,
  prior: NonNullable<ReturnType<typeof priorRevisionDelivery>>,
) => {
  const { proposalDigest } = prior.delivery.subject;
  if (prior.reconcile === undefined) {
    return await runtime.inspectPublishedPullRequest?.(proposalDigest);
  }
  const reviewedHead = await runtime.inspectPublishedReconciliationHead?.(
    proposalDigest,
    prior.reconcile,
  );
  return reviewedHead === undefined || reviewedHead === null
    ? null
    : await runtime.inspectPublishedPullRequest?.(proposalDigest, reviewedHead);
};

interface ReconciliationObservationPorts {
  publication?: (
    auth: ToolContext["session"]["auth"],
    options: { selectedInstallationId: string },
  ) => Promise<
    Pick<
      GitHubPublicationRuntime,
      | "inspectPublishedPullRequest"
      | "inspectPublishedReconciliationHead"
      | "inspectExistingDraftReconciliationSource"
      | "readSucceededDraftPublication"
    >
  >;
}

export type ProductionReconciliationFailure =
  | ReconciliationCandidateFailure
  | "candidate-review-unavailable"
  | "prior-approved-revision-unavailable"
  | typeof approvedReleaseMismatch
  | "prior-delivery-unavailable"
  | "release-selection-changed"
  | "github-draft-mismatch"
  | "github-origin-mismatch"
  | "github-base-mismatch"
  | "github-installation-mismatch"
  | "github-prior-merge-mismatch"
  | "github-read-unavailable";

/** A new combined decision can replace the grant for an exact still-draft schema revision. */
export const prepareDirectProductionDraftReconciliation = async (
  ctx: ToolContext,
  ports: ReconciliationObservationPorts = {},
): Promise<ProductionReconciliationFailure | null> => {
  ctx.abortSignal.throwIfAborted();
  const state = appBuilderWorkflowState.get();
  const { grant } = authorization.get();
  const candidate = draftReconciliationState.get();
  if (
    !("proposal" in state) ||
    grant?.subject.revision?.schemaChange === undefined ||
    candidate?.appId !== state.appSpec.appId
  ) {
    return null;
  }
  if (state.phase !== "reviewed" || reviewedDraftReconciliation(state) === null) {
    return "candidate-review-unavailable";
  }
  if (grant.subject.proposalDigest !== state.proposal.digest) {
    return approvedReleaseMismatch;
  }
  const predecessor = revisionPredecessor(state.proposal.digest);
  if (predecessor === undefined) {
    return "prior-approved-revision-unavailable";
  }
  const subject = subjectForProposal(ctx, state, [], predecessor);
  if (subject === undefined) {
    return approvedReleaseMismatch;
  }
  let candidateFailure: ReconciliationCandidateFailure = candidateReviewMismatch;
  const corrected = directDraftReconciliationScope(state, subject, grant, (reason) => {
    candidateFailure = reason;
  });
  if (corrected === null) {
    return candidateFailure;
  }
  // A new approved revision already retained this predecessor. A stopped older
  // Finish call locates its immutable PR only; GitHub must still prove the merge.
  const prior = priorRevisionDelivery(state, predecessor, readAnchoredMerge);
  if (prior === null) {
    return "prior-delivery-unavailable";
  }
  const approvedRepair = grant.subject.revision.reconciliation;
  if (approvedRepair === undefined && !sameSubject(subject, grant.subject)) {
    return approvedReleaseMismatch;
  }
  if (approvedRepair !== undefined) {
    const repaired = corrected.subject.revision?.reconciliation;
    const matchesDraft = [
      repaired?.originPublicationDigest === approvedRepair.originPublicationDigest,
      repaired?.originPublicationReceiptDigest === approvedRepair.originPublicationReceiptDigest,
      repaired?.pullRequestNumber === approvedRepair.pullRequestNumber,
      repaired?.expectedHeadSha === approvedRepair.expectedHeadSha,
    ].every(Boolean);
    if (!matchesDraft) {
      return "github-origin-mismatch";
    }
    if (sameSubject(grant.subject, corrected.subject)) {
      return null;
    }
  }
  authorization.update((current) =>
    current.reconciliation ? { ...current, reconciliation: null } : current,
  );
  const { proposal } = corrected;
  const isCurrent = () => {
    ctx.abortSignal.throwIfAborted();
    return (
      isDeepStrictEqual(appBuilderWorkflowState.get(), state) &&
      isDeepStrictEqual(authorization.get().grant, grant) &&
      isDeepStrictEqual(priorRevisionDelivery(state, predecessor, readAnchoredMerge), prior) &&
      isDeepStrictEqual(directDraftReconciliationScope(state, subject, grant), corrected)
    );
  };
  try {
    const runtime = await (ports.publication ?? githubPublicationRuntimeForSession)(
      ctx.session.auth,
      { selectedInstallationId: subject.installationId },
    );
    if (!isCurrent()) {
      return "release-selection-changed";
    }
    const [owned, origin, previous] = await Promise.all([
      runtime.inspectExistingDraftReconciliationSource({
        repositoryId: proposal.repositoryId,
        owner: proposal.owner,
        name: proposal.name,
        pullRequestNumber: proposal.pullRequestNumber,
        priorPublishedProposalDigest: corrected.originPublicationDigest,
      }),
      runtime.readSucceededDraftPublication?.(corrected.originPublicationDigest),
      observePriorRevisionPullRequest(runtime, prior),
    ]);
    if (!isCurrent()) {
      return "release-selection-changed";
    }
    const { draft, base, publishedHeadSha } = owned;
    const draftMatches = [
      draft.state === "open",
      draft.draft,
      draft.repositoryId === proposal.repositoryId,
      draft.headRepositoryId === proposal.repositoryId,
      draft.baseRepositoryId === proposal.repositoryId,
      draft.number === proposal.pullRequestNumber,
      draft.pullRequestId === proposal.pullRequestId,
      draft.headBranch === proposal.branchName,
      draft.baseBranch === proposal.baseBranch,
      draft.verifiedBuilderOrigin?.marker === proposal.originMarker,
      draft.headSha === proposal.expectedHeadSha,
      draft.headTree === proposal.expectedHeadTree,
      publishedHeadSha === proposal.expectedHeadSha,
    ].every(Boolean);
    if (!draftMatches) {
      return "github-draft-mismatch";
    }
    const originMatches = [
      origin?.proposalDigest === corrected.originPublicationDigest,
      origin?.digest === proposal.priorPublicationDigest,
      origin?.branchSha === proposal.expectedHeadSha,
      origin?.branchTree === proposal.expectedHeadTree,
    ].every(Boolean);
    if (!originMatches) {
      return "github-origin-mismatch";
    }
    if (base.headSha !== proposal.expectedBaseSha || base.headTree !== proposal.expectedBaseTree) {
      return "github-base-mismatch";
    }
    if (base.installationIdentityDigest !== proposal.installationIdentityDigest) {
      return "github-installation-mismatch";
    }
    const merged = previous?.reviewedTarget;
    const predecessorMerged = [
      previous?.state === "merged",
      previous?.reviewedRevision === true,
      previous?.mergeCommitSha !== undefined,
      merged?.repositoryId === proposal.repositoryId,
      merged?.owner === proposal.owner,
      merged?.name === proposal.name,
      merged?.baseBranch === proposal.baseBranch,
      merged?.pullRequestNumber !== proposal.pullRequestNumber,
    ].every(Boolean);
    if (!predecessorMerged) {
      return "github-prior-merge-mismatch";
    }
    authorization.update((current) => ({
      ...current,
      reconciliation: { failedGrantDigest: grant.digest, subject: corrected.subject },
    }));
    return null;
  } catch {
    ctx.abortSignal.throwIfAborted();
    return "github-read-unavailable";
  }
};

export const directProductionReconciliationContinuation = (subject: DirectProductionSubject) => {
  const marker = subject.revision?.reconciliation;
  const proposal = draftReconciliationState.get()?.proposal;
  if (marker === undefined || proposal?.digest !== marker.digest) {
    return null;
  }
  return {
    tool: "reconcile_github_draft_pr" as const,
    input: {
      expectedProposalDigest: marker.digest,
      approvalReceipt: approvalReceiptForExistingDraftUpdate(proposal),
    },
  };
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
  const priorDelivery = subject === undefined ? null : priorRevisionDelivery(state, grant);
  if (subject === undefined || priorDelivery === null) {
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
  const { owner, name } = priorDelivery;
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
    const observed = await observePriorRevisionPullRequest(runtime, priorDelivery);
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

/** A completed delivery is the predecessor for a new change, not a fresh approval subject. */
export const currentDirectProductionProposalIsDelivered = (ctx: OwnerContext): boolean => {
  const state = appBuilderWorkflowState.get();
  const progress = directProductionProgressState.get();
  const delivered = directProductionDeliverySettled(progress?.stage);
  if (!delivered || !("proposal" in state)) {
    return false;
  }
  const grant = currentDirectProductionGrant(ctx, { appId: state.appSpec.appId });
  return grant !== undefined && progress?.grantDigest === grant.digest;
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
