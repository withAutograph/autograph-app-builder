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
import { reconcilePlanningSource } from "../repository/planning-source-reconciliation";
import { readAppBaselineMarker } from "../repository/app-baseline";
import { resolveVercelSessionGitSource } from "../sandbox/vercel-session-source";

type RefreshableSourceState = Extract<AppBuilderWorkflowState, { appSpec: AcceptedAppSpec }>;
const canRefreshSource = (
  state: AppBuilderWorkflowState,
  purpose: "planning" | "schema-compilation",
): state is RefreshableSourceState => {
  if (["app_spec_accepted", "dependencies_prepared", "identity_resolved"].includes(state.phase)) {
    return true;
  }
  return (
    purpose === "schema-compilation" &&
    ["applied", "validation_failed", "validated"].includes(state.phase)
  );
};

/** Reconcile branch foundations before planning while retaining the accepted product and authored source. */
export const refreshPlanningSource = async (
  ctx: Pick<ToolContext, "callId" | "getSandbox"> & { session: { auth: unknown; id: string } },
  purpose: "planning" | "schema-compilation" = "planning",
) => {
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
      await reconcilePlanningSource(reconciliation);
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
    purpose === "schema-compilation" && "applyReceipt" in current
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
