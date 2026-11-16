import { refreshLocalPlanningSource } from "./refresh-local-planning-source";
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { appBaselineState } from "./app-baseline-state";
import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { repositoryAccessReceiptState } from "./repository-access-state";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "./source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
} from "./workflow-state";
import type { AcceptedAppSpec, AppBuilderWorkflowState } from "./workflow-state";
import { getSourceBoundSandbox } from "./source-bound-sandbox";
import {
  PlanningReleaseConflictError,
  reconcilePlanningSource,
} from "../repository/planning-source-reconciliation";
import {
  readPriorApprovedMergedSchemaRelease,
  readSettledDirectProductionPlanningMerge,
  settledDirectProductionDelivery,
} from "./direct-production-state";
import type { UnsettledProductionDeliveryReason } from "./direct-production-state";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { assertExactImmutableGitHubSourceReceipt } from "../repository/github-publication";
import {
  assertApprovedPrivateApplySession,
  assertNoPendingPrivateApplyApproval,
} from "./private-apply-authority";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { readConnectedSchemaSavedPredecessor } from "./connected-schema-saved-predecessor";
import type { PublishedPlanningRelease } from "../repository/planning-source-reconciliation";
import { preserveUnissuedConnectedSchemaRelease } from "../repository/connected-schema-release-recovery";
import {
  readMergedReleaseSourceRecovery,
  retainedMergedSchemaReleaseId,
} from "./merged-release-source-recovery";
import { readAppBaselineMarker } from "../repository/app-baseline";
import { resolveVercelSessionGitSource } from "../sandbox/vercel-session-source";
import { readGeneratedSchemaReleaseId } from "../repository/optional-text-field";
import { assertRetainedGitHubSourceCheckout } from "../repository/sandbox-github-source";

const schemaCompilation = "schema-compilation";

const recoverApprovedHistoricalRelease = async (input: {
  current: Extract<AppBuilderWorkflowState, { applyReceipt: unknown }>;
  ctx: ToolContext;
  expectedCueSha256: string;
  releaseId: string;
  sandbox: SandboxSession;
}) => {
  const { current, ctx, expectedCueSha256, releaseId, sandbox } = input;
  const appRoot = `apps/${current.appSpec.appId}/schema`;
  const releaseRoot = `${appRoot}/release/${releaseId}`;
  if (
    current.applyReceipt.applyRoot !== "/workspace/repository" ||
    current.workspace.workspaceId !== getBuilderSandboxId(sandbox) ||
    current.applyReceipt.changes.some(
      ({ path }) => path === releaseRoot || path.startsWith(`${releaseRoot}/`),
    )
  ) {
    return null;
  }
  const cue = await sandbox.readBinaryFile({
    abortSignal: ctx.abortSignal,
    path: `repository/${appRoot}/${current.appSpec.appId}.cue`,
  });
  if (cue === null || createHash("sha256").update(cue).digest("hex") !== expectedCueSha256) {
    return null;
  }
  const currentReleaseId = readGeneratedSchemaReleaseId(new TextDecoder().decode(cue));
  if (currentReleaseId === null || currentReleaseId === releaseId) {
    return null;
  }
  return await readPriorApprovedMergedSchemaRelease(ctx, releaseId, expectedCueSha256);
};

type SettledSourcePlanningProof = () => void;
// oxlint-disable-next-line sonarjs/max-union-size -- Fixed server-side telemetry categories, not user input.
export type SettledSourcePlanningOutcome =
  | UnsettledProductionDeliveryReason
  | "local-source"
  | "not-reviewed"
  | "reconciliation-anchor-missing"
  | "connected-source-missing"
  | "source-digests-unchanged"
  | "proof-produced";

type RefreshableSourceState = Extract<AppBuilderWorkflowState, { appSpec: AcceptedAppSpec }>;
const canRefreshSource = (
  state: AppBuilderWorkflowState,
  purpose: "planning" | "schema-compilation",
): state is RefreshableSourceState => {
  if (["app_spec_accepted", "dependencies_prepared", "identity_resolved"].includes(state.phase)) {
    return true;
  }
  return (
    purpose === schemaCompilation &&
    ["applied", "validation_failed", "validated"].includes(state.phase)
  );
};

/** Reconcile branch foundations before planning while retaining the accepted product and authored source. */
export const refreshPlanningSource = async (
  ctx: ToolContext,
  purpose: "planning" | "schema-compilation" = "planning",
  options: {
    approvedSchemaCueSha256?: string | undefined;
    settledRevisionPlanning?: "existing-files" | "optional-field";
    recordSettledSourcePlanningProof?: (proof: SettledSourcePlanningProof) => void;
    recordSettledSourcePlanningOutcome?: (outcome: SettledSourcePlanningOutcome) => void;
  } = {},
) => {
  const recordOutcome = options.recordSettledSourcePlanningOutcome;
  if (purpose === "planning") {
    const local = await refreshLocalPlanningSource(ctx);
    if (local !== undefined) {
      recordOutcome?.("local-source");
      return local;
    }
  }
  const current = appBuilderWorkflowState.get();
  const sandbox = await getSourceBoundSandbox(ctx);
  if (current.phase !== "reviewed") {
    recordOutcome?.("not-reviewed");
  }
  const recordOwnershipOutcome = current.phase === "reviewed" ? recordOutcome : undefined;
  const refreshedAfterApply =
    current.phase === "reviewed" &&
    (current.applyReceipt.sourceReceiptDigest !== current.sourceReceipt.digest ||
      current.applyReceipt.workspaceDigest !== current.workspace.workspaceDigest);
  const planExistingFiles =
    options.settledRevisionPlanning === "existing-files" && refreshedAfterApply;
  const useSettledSource =
    options.settledRevisionPlanning === "optional-field" || planExistingFiles;
  const currentDelivery =
    useSettledSource && "applyReceipt" in current
      ? settledDirectProductionDelivery(ctx, recordOwnershipOutcome)
      : undefined;
  const reconciliationAnchor = currentDelivery?.subject.revision?.reconciliation;
  if (
    current.phase === "reviewed" &&
    currentDelivery !== undefined &&
    reconciliationAnchor === undefined &&
    !planExistingFiles
  ) {
    recordOutcome?.("reconciliation-anchor-missing");
  }
  const preserveSourceHead =
    (reconciliationAnchor !== undefined || (planExistingFiles && currentDelivery !== undefined)) &&
    "applyReceipt" in current;
  if (!preserveSourceHead && !canRefreshSource(current, purpose)) {
    return sandbox;
  }
  const selected = current.githubSource;
  if (selected === undefined) {
    recordOutcome?.("connected-source-missing");
    return sandbox;
  }
  const access = repositoryAccessReceiptState.get();
  if (access === undefined) {
    throw new Error(
      "Reconnect the selected repository before continuing this app's source planning.",
    );
  }
  const baseline = appBaselineState.get();
  const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
  const repository = `${selected.repository.owner}/${selected.repository.name}`;
  const observedAccess = await runtime.classify({
    repository,
    selectedInstallationId: access.scope.installationId,
  });
  if (observedAccess.status !== "ready") {
    throw new Error(
      "The selected repository's existing read access is unavailable. Reconnect it and continue this same app.",
    );
  }
  const readSelectedBranch = async () => {
    const publication = await githubPublicationRuntimeForSession(ctx.session.auth);
    return await publication.inspectSourceBranch({
      branch: selected.resolvedRef.slice("refs/heads/".length),
      name: selected.repository.name,
      owner: selected.repository.owner,
      repositoryId: selected.repository.repositoryId,
    });
  };
  if (preserveSourceHead && currentDelivery !== undefined) {
    const { applyReceipt, proposal, workspace, sourceReceipt } = current;
    const assertPlanningScope = () => {
      ctx.abortSignal.throwIfAborted();
      assertExactWorkflowState(
        appBuilderWorkflowState.get(),
        current,
        "plan the next app revision",
      );
      if (
        settledDirectProductionDelivery(ctx)?.effectDigest !== currentDelivery.effectDigest ||
        getBuilderSandboxId(sandbox) !== workspace.workspaceId
      ) {
        throw new Error(
          "The settled app or its private checkout changed during revision planning.",
        );
      }
      assertNoPendingPrivateApplyApproval();
      assertApprovedPrivateApplySession({
        appId: current.appSpec.appId,
        appSpecDigest: current.appSpec.digest,
        proposalDigest: proposal.digest,
        sessionId: ctx.session.id,
        workspaceId: workspace.workspaceId,
      });
    };
    if (refreshedAfterApply) {
      assertExactImmutableGitHubSourceReceipt(selected);
      // The original Build remains immutable. Only the next plan uses the
      // connected checkout that was refreshed during its schema compilation.
      const approvedBuildMatches = [
        applyReceipt.proposalDigest === proposal.digest,
        applyReceipt.appSpecDigest === proposal.appSpecDigest,
        proposal.appSpecDigest === current.appSpec.digest,
        applyReceipt.appSpecPath === current.appSpec.artifactPath,
        applyReceipt.artifactRevision === current.appSpec.artifactRevision,
        applyReceipt.targetReceipt.appId === current.appSpec.appId,
        applyReceipt.sourceReceiptDigest === proposal.sourceReceiptDigest,
        applyReceipt.workspaceDigest === proposal.workspaceDigest,
        applyReceipt.eligibilityDigest === proposal.eligibilityDigest,
        applyReceipt.sourceSha === proposal.sourceSha,
        applyReceipt.sourceTree === proposal.sourceTree,
        applyReceipt.applyRoot === workspace.workspacePath,
        sourceReceipt.sourceKind === "existing-repository",
        sourceReceipt.sourcePath === workspace.sourcePath,
        sourceReceipt.sourceSha === workspace.sourceSha,
        sourceReceipt.sourceTree === workspace.sourceTree,
        selected.resolvedSha === workspace.sourceSha,
        selected.resolvedTree === workspace.sourceTree,
      ].every(Boolean);
      if (!approvedBuildMatches) {
        throw new Error(
          "The original Build and the settled app's connected checkout could not be verified.",
        );
      }
      assertPlanningScope();
    }
    if (planExistingFiles) {
      const sameDestination =
        currentDelivery.subject.repositoryId === selected.repository.repositoryId &&
        currentDelivery.subject.repositoryFullName === repository &&
        `refs/heads/${currentDelivery.subject.baseBranch}` === selected.resolvedRef &&
        currentDelivery.subject.installationId === access.scope.installationId;
      if (
        !sameDestination ||
        (await readSettledDirectProductionPlanningMerge(ctx, currentDelivery.effectDigest)) === null
      ) {
        throw new Error(
          "Builder could not verify the saved app’s reviewed merge before planning the next revision.",
        );
      }
      assertPlanningScope();
      await assertRetainedGitHubSourceCheckout(sandbox, {
        repository: `https://github.com/${repository}.git`,
        sourceSha: workspace.sourceSha,
        sourceTree: workspace.sourceTree,
      });
      assertPlanningScope();
      options.recordSettledSourcePlanningProof?.(assertPlanningScope);
      recordOutcome?.("proof-produced");
      return sandbox;
    }
    const revision = await readSelectedBranch();
    const releaseId = retainedMergedSchemaReleaseId(
      current.proposal.digest,
      current.appSpec.appId,
      reconciliationAnchor,
    );
    if (releaseId === undefined) {
      throw new Error(
        "Builder could not verify the saved app’s published schema before planning the next revision.",
      );
    }
    const publishedRelease = await readMergedReleaseSourceRecovery({
      current,
      ctx,
      installationId: access.scope.installationId,
      releaseId,
      includeSchemaCue: true,
      reconciliationAnchor,
    });
    if (publishedRelease === null || publishedRelease.cueSha256 === undefined) {
      throw new Error("Builder could not read the verified published schema for this app.");
    }
    const credential = await runtime.acquireExistingSourceCredential({
      installationId: access.scope.installationId,
      repository: selected.repository,
      sessionId: ctx.session.id,
    });
    ctx.abortSignal.throwIfAborted();
    assertExactWorkflowState(
      appBuilderWorkflowState.get(),
      current,
      "restore published schema before planning the approved app’s next revision",
    );
    const recovery: Parameters<typeof reconcilePlanningSource>[0] = {
      adoptPublishedSchemaCue: true,
      appId: current.appSpec.appId,
      baseline: baseline?.selection,
      branchRef: selected.resolvedRef,
      preserveSourceHead: true,
      publishedRelease,
      repository: `https://github.com/${repository}.git`,
      sandbox,
      sessionId: ctx.session.id,
      targetSha: revision.headSha,
      token: credential.token,
    };
    if (refreshedAfterApply) {
      assertPlanningScope();
      recovery.expectedPreservedSource = { sha: workspace.sourceSha, tree: workspace.sourceTree };
    }
    await reconcilePlanningSource(recovery);
    if (refreshedAfterApply) {
      assertPlanningScope();
      options.recordSettledSourcePlanningProof?.(assertPlanningScope);
      recordOutcome?.("proof-produced");
    } else if (current.phase === "reviewed") {
      recordOutcome?.("source-digests-unchanged");
    }
    return sandbox;
  }
  const revision = await readSelectedBranch();
  const prepared = await runtime.prepareExistingSource({
    access: observedAccess,
    callId: ctx.callId,
    currentAccessReceipt: access,
    currentGitHubSource: selected,
    repository,
    revision,
    sandbox: async () => {
      const configured = await resolveVercelSessionGitSource(ctx.session.id);
      if (configured === undefined) {
        throw new Error(
          "The selected repository read credential was not configured for source reconciliation.",
        );
      }
      const reconciliation: Parameters<typeof reconcilePlanningSource>[0] = {
        appId: current.appSpec.appId,
        branchRef: selected.resolvedRef,
        repository: configured.url,
        sandbox,
        sessionId: ctx.session.id,
        targetSha: revision.headSha,
        token: configured.token,
      };
      if (baseline !== undefined) {
        reconciliation.baseline = baseline.selection;
      }
      const recover =
        purpose === schemaCompilation && "applyReceipt" in current
          ? async (releaseId: string) =>
              await readMergedReleaseSourceRecovery({
                current,
                ctx,
                installationId: access.scope.installationId,
                releaseId,
              })
          : undefined;
      const saved =
        options.approvedSchemaCueSha256 !== undefined && "applyReceipt" in current
          ? await readConnectedSchemaSavedPredecessor({
              adapterSessionId: ctx.session.id,
              appId: current.appSpec.appId,
              appSpecDigest: current.appSpec.digest,
              callId: ctx.callId,
              callbackExecution: hostedOperatorCallbackExecution(ctx.session),
              expectedCueSha256: options.approvedSchemaCueSha256,
              root: current.applyReceipt.applyRoot,
              sessionAuth: ctx.session.auth,
              signal: ctx.abortSignal,
            })
          : null;
      const prior = saved?.prior;
      const recoverReleaseId =
        options.approvedSchemaCueSha256 !== undefined && "applyReceipt" in current
          ? (retainedMergedSchemaReleaseId(current.proposal.digest, current.appSpec.appId) ??
            prior?.releaseId)
          : undefined;
      let recovered: PublishedPlanningRelease | null = null;
      if (recoverReleaseId !== undefined && recover !== undefined) {
        const published = await recover(recoverReleaseId);
        if (published !== null) {
          recovered = published;
          reconciliation.publishedRelease = published;
        }
      }
      ctx.abortSignal.throwIfAborted();
      assertExactWorkflowState(
        appBuilderWorkflowState.get(),
        current,
        "refresh the approved app checkout",
      );
      try {
        await reconcilePlanningSource(reconciliation);
      } catch (error) {
        if (recover === undefined || !(error instanceof PlanningReleaseConflictError)) {
          throw error;
        }
        const needsApprovalProof = error.reason === "approved-cue-required";
        if (!needsApprovalProof && reconciliation.publishedRelease?.releaseId === error.releaseId) {
          throw error;
        }
        recovered = needsApprovalProof ? null : await recover(error.releaseId);
        const approvedCue = options.approvedSchemaCueSha256;
        if (recovered === null && approvedCue !== undefined && "applyReceipt" in current) {
          recovered = await recoverApprovedHistoricalRelease({
            current,
            ctx,
            expectedCueSha256: approvedCue,
            releaseId: error.releaseId,
            sandbox,
          });
          if (recovered !== null) {
            reconciliation.expectedApprovedSchemaCueSha256 = approvedCue;
          }
        }
        if (recovered === null) {
          throw error;
        }
        ctx.abortSignal.throwIfAborted();
        assertExactWorkflowState(
          appBuilderWorkflowState.get(),
          current,
          "restore checked history while compiling the approved app",
        );
        await reconcilePlanningSource({ ...reconciliation, publishedRelease: recovered });
      }
      const publishedReleaseId = recovered?.releaseId;
      const publishedManifestSha256 = recovered?.files["release-manifest.json"];
      const publishedArtifactSha256 = recovered?.files["app-artifact.json"];
      const candidate = saved?.candidate;
      const originalPrior = prior?.releaseId === recovered?.releaseId ? prior : undefined;
      const needsRegeneration =
        originalPrior?.onlineProof !== true ||
        publishedArtifactSha256 !== originalPrior.artifactSha256 ||
        (originalPrior.previousManifestSha256 !== undefined &&
          publishedManifestSha256 !== originalPrior.previousManifestSha256);
      const exactRecovery =
        publishedReleaseId !== undefined &&
        publishedManifestSha256 !== undefined &&
        publishedArtifactSha256 !== undefined;
      if (
        exactRecovery &&
        needsRegeneration &&
        candidate !== undefined &&
        options.approvedSchemaCueSha256 !== undefined
      ) {
        ctx.abortSignal.throwIfAborted();
        assertExactWorkflowState(
          appBuilderWorkflowState.get(),
          current,
          "regenerate the unissued schema against published history",
        );
        await preserveUnissuedConnectedSchemaRelease({
          appId: current.appSpec.appId,
          expectedArtifactSha256: candidate.schemaSha256,
          expectedCueSha256: options.approvedSchemaCueSha256,
          expectedManifestSha256: candidate.manifestSha256,
          expectedPredecessorArtifactSha256:
            originalPrior?.artifactSha256 ?? publishedArtifactSha256,
          expectedSourceSha: revision.headSha,
          releaseId: candidate.releaseId,
          restoredPublishedPredecessor: {
            previousManifestSha256:
              originalPrior?.previousManifestSha256 ?? publishedManifestSha256,
            publishedManifestSha256,
            releaseId: publishedReleaseId,
          },
          sandbox,
          signal: ctx.abortSignal,
        });
      }
      return sandbox;
    },
    selectedInstallationId: access.scope.installationId,
    sessionId: ctx.session.id,
  });
  const refreshedBaseline =
    baseline === undefined ? undefined : await readAppBaselineMarker(sandbox, baseline.selection);
  if (baseline !== undefined && refreshedBaseline === undefined) {
    throw new Error("The historical app source marker is unavailable after source reconciliation.");
  }
  if (
    prepared.workspace.sourceSha === current.workspace.sourceSha &&
    prepared.githubSource.resolvedSha === selected.resolvedSha
  ) {
    return sandbox;
  }
  // The Git checkpoint/checkout and marker transition precede these durable Eve
  // state writes. New planning receipts are derived from the retained AppSpec.
  const refreshed: AppBuilderWorkflowState =
    purpose === schemaCompilation && "applyReceipt" in current
      ? {
          ...current,
          githubSource: prepared.githubSource,
          preparedByCallId: ctx.callId,
          sourceReceipt: prepared.sourceReceipt,
          workspace: prepared.workspace,
        }
      : {
          appSpec: current.appSpec,
          artifacts: current.artifacts,
          githubSource: prepared.githubSource,
          phase: "app_spec_accepted",
          preparedByCallId: ctx.callId,
          sourceReceipt: prepared.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: prepared.workspace,
        };
  if (current.checkoutDependencyAttempts !== undefined) {
    refreshed.checkoutDependencyAttempts = current.checkoutDependencyAttempts;
  }
  appBuilderWorkflowState.update((latest) => {
    assertExactWorkflowState(latest, current, "current-branch source reconciliation");
    return refreshed;
  });
  sourceWorkflowState.update((latest) => {
    if (latest.phase === "empty") {
      return {
        githubSource: prepared.githubSource,
        phase: "reviewed",
        receipt: prepared.sourceReceipt,
        version: APP_BUILDER_SOURCE_VERSION,
      };
    }
    return {
      ...latest,
      githubSource: prepared.githubSource,
      receipt: prepared.sourceReceipt,
      version: APP_BUILDER_SOURCE_VERSION,
    };
  });
  repositoryAccessReceiptState.update(() => prepared.accessReceipt);
  if (baseline !== undefined && refreshedBaseline !== undefined) {
    appBaselineState.update(() => ({
      receipt: refreshedBaseline.receipt,
      selection: baseline.selection,
    }));
  }
  return sandbox;
};
