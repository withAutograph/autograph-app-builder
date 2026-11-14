import { refreshLocalPlanningSource } from "./refresh-local-planning-source";
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
import { readMergedReleaseSourceRecovery } from "./merged-release-source-recovery";
import { readAppBaselineMarker } from "../repository/app-baseline";
import { resolveVercelSessionGitSource } from "../sandbox/vercel-session-source";

const schemaCompilation = "schema-compilation";

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
) => {
  if (purpose === "planning") {
    const local = await refreshLocalPlanningSource(ctx);
    if (local !== undefined) {
      return local;
    }
  }
  const current = appBuilderWorkflowState.get();
  const sandbox = await getSourceBoundSandbox(ctx);
  if (!canRefreshSource(current, purpose)) {
    return sandbox;
  }
  const selected = current.githubSource;
  if (selected === undefined) {
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
  const publication = await githubPublicationRuntimeForSession(ctx.session.auth);
  const revision = await publication.inspectSourceBranch({
    branch: selected.resolvedRef.slice("refs/heads/".length),
    name: selected.repository.name,
    owner: selected.repository.owner,
    repositoryId: selected.repository.repositoryId,
  });
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
      try {
        await reconcilePlanningSource(reconciliation);
      } catch (error) {
        if (
          purpose !== schemaCompilation ||
          !(error instanceof PlanningReleaseConflictError) ||
          !("applyReceipt" in current)
        ) {
          throw error;
        }
        const publishedRelease = await readMergedReleaseSourceRecovery({
          current,
          ctx,
          installationId: access.scope.installationId,
          releaseId: error.releaseId,
        });
        if (publishedRelease === null) {
          throw error;
        }
        ctx.abortSignal.throwIfAborted();
        assertExactWorkflowState(
          appBuilderWorkflowState.get(),
          current,
          "restore checked history while compiling the approved app",
        );
        await reconcilePlanningSource({ ...reconciliation, publishedRelease });
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
