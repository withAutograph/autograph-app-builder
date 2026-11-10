import { isDeepStrictEqual } from "node:util";
import type { ToolContext } from "eve/tools";
import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import type { RepositoryAccessRuntime } from "./deployment-repository-access-runtime";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";
import {
  repositoryAccessReceiptSchema,
  repositoryAccessReceiptState,
  recordRepositoryAccessReceipt,
} from "./repository-access-state";
import { appBuilderWorkflowState, assertExactWorkflowState } from "./workflow-state";
import { sourceWorkflowState } from "./source-state";
import { draftReconciliationState } from "./draft-reconciliation-state";
import { resolveGitHubPrDeliverySubject } from "./github-pr-delivery-subject";
import { recoverHostedTemplateFoundation } from "./hosted-template-foundation-recovery";
import { reconcileHostedTemplateFoundation } from "../repository/hosted-template-source-reconciliation";
import {
  ARRUSTED_TEMPLATE_FULL_NAME,
  ARRUSTED_TEMPLATE_REPOSITORY_ID,
} from "../repository/arrusted-template-reader";

interface RefreshPorts {
  access?: Pick<RepositoryAccessRuntime, "classify" | "acquireExistingSourceCredential">;
  publication?: Pick<GitHubPublicationRuntime, "inspectDraftDestination" | "inspectSourceBranch">;
  reconcile?: typeof reconcileHostedTemplateFoundation;
}
const unavailableAccess = () =>
  new Error(
    "Reconnect this app's selected repository and continue the same app; existing work and data are preserved.",
  );

/** Refresh the same delivered app privately; publication and runtime/resource ownership do not change. */
export const refreshOwnedAppSource = async (ctx: ToolContext, ports: RefreshPorts = {}) => {
  ctx.abortSignal?.throwIfAborted();
  const current = appBuilderWorkflowState.get();
  if (
    !["applied", "validation_failed", "validated", "reviewed"].includes(current.phase) ||
    !("applyReceipt" in current) ||
    current.sourceReceipt.sourceKind !== "fresh-template" ||
    current.githubSource !== undefined
  ) {
    throw new Error(
      "Refresh the source of this same settled, delivered app; preserve any unfinished operation first.",
    );
  }
  const source = sourceWorkflowState.get();
  const candidate = draftReconciliationState.get();
  const savedAccess = repositoryAccessReceiptState.get();
  const access = repositoryAccessReceiptSchema.parse(savedAccess);
  const delivery = resolveGitHubPrDeliverySubject(current, candidate);
  const proposalDigest = current.publishedGitHubDraftProposalDigest ?? delivery?.proposalDigest;
  if (
    proposalDigest === undefined ||
    access.sessionId !== ctx.session.id ||
    (delivery?.installationId !== undefined &&
      delivery.installationId !== access.scope.installationId)
  ) {
    throw new Error(
      "This app's saved publication and connected repository access must belong to the same Builder session.",
    );
  }
  const assertCurrent = () => {
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(
      appBuilderWorkflowState.get(),
      current,
      "refresh this app's shared source",
    );
    if (
      !isDeepStrictEqual(sourceWorkflowState.get(), source) ||
      !isDeepStrictEqual(draftReconciliationState.get(), candidate) ||
      !isDeepStrictEqual(repositoryAccessReceiptState.get(), savedAccess)
    ) {
      throw new Error("This app's source, publication or repository access changed concurrently.");
    }
  };
  assertCurrent();
  const runtime = ports.access ?? (await repositoryAccessRuntimeForSession(ctx.session.auth));
  const observed = await runtime.classify({
    repository: `${access.repository.owner}/${access.repository.name}`,
    selectedInstallationId: access.scope.installationId,
  });
  assertCurrent();
  if (observed.status !== "ready") {
    throw unavailableAccess();
  }
  if (
    observed.repository.repositoryId !== access.repository.repositoryId ||
    observed.repository.owner !== access.repository.owner ||
    observed.repository.name !== access.repository.name ||
    observed.scope.installationId !== access.scope.installationId
  ) {
    throw unavailableAccess();
  }
  // Canonical starter transport can refresh only that same repository. A delivery destination never replaces source provenance.
  if (
    `${observed.repository.owner}/${observed.repository.name}` !== ARRUSTED_TEMPLATE_FULL_NAME ||
    observed.repository.repositoryId !== String(ARRUSTED_TEMPLATE_REPOSITORY_ID)
  ) {
    throw new Error(
      "This app's canonical source refresh cannot substitute a different repository or branch. Its existing work and delivery destination are preserved.",
    );
  }
  const publication =
    ports.publication ??
    (await githubPublicationRuntimeForSession(ctx.session.auth, {
      selectedInstallationId: observed.scope.installationId,
    }));
  if (publication.inspectDraftDestination === undefined) {
    throw new Error(
      "The repository connection cannot inspect this app's saved publication yet. Preserve this session and retry after the service is available.",
    );
  }
  const inspected = await publication.inspectDraftDestination({
    destination: { ...observed.repository, installationId: observed.scope.installationId },
    ownedAppRevision: {
      appId: current.appSpec.appId,
      proposalDigest,
      installationId: observed.scope.installationId,
    },
    paths: [`apps/${current.appSpec.appId}/package.json`],
  });
  assertCurrent();
  const owned = inspected.ownedCompletedPublication;
  if (
    owned === undefined ||
    owned.proposal.digest !== proposalDigest ||
    owned.proposal.repositoryId !== access.repository.repositoryId ||
    owned.installationId !== access.scope.installationId
  ) {
    throw new Error(
      "Continue this app's existing publication before refreshing its delivered source. No app, repository or data was replaced.",
    );
  }
  // The canonical starter receipt names refs/heads/main. A renamed delivery
  // default branch stays selected; it does not redefine that source provenance.
  const head =
    inspected.repository.defaultBranch === "main"
      ? { headSha: inspected.repository.headSha, headTree: inspected.repository.headTree }
      : await publication.inspectSourceBranch({ ...observed.repository, branch: "main" });
  assertCurrent();
  const changed = await recoverHostedTemplateFoundation(
    ctx,
    { appId: current.appSpec.appId, root: current.workspace.workspacePath },
    async (input) => {
      const reconcile = ports.reconcile ?? reconcileHostedTemplateFoundation;
      return await reconcile({
        ...input,
        assertCurrent: async () => {
          await input.assertCurrent();
          assertCurrent();
        },
        reader: {
          acquire: async () => {
            assertCurrent();
            const credential = await runtime.acquireExistingSourceCredential({
              sessionId: ctx.session.id,
              repository: observed.repository,
              installationId: observed.scope.installationId,
            });
            assertCurrent();
            return credential;
          },
        },
        readCanonicalHead: async () =>
          await Promise.resolve({ sourceSha: head.headSha, sourceTree: head.headTree }),
      });
    },
    owned,
  );
  ctx.abortSignal?.throwIfAborted();
  repositoryAccessReceiptState.update((latest) => {
    if (!isDeepStrictEqual(latest, savedAccess)) {
      throw new Error(
        "The repository connection changed while the source refresh completed. The saved source and newer connection are preserved.",
      );
    }
    return recordRepositoryAccessReceipt({
      current: access,
      sessionId: ctx.session.id,
      confirmedByCallId: ctx.callId,
      access: observed,
    });
  });
  return {
    appId: current.appSpec.appId,
    status: changed ? ("source_refreshed" as const) : ("source_unchanged" as const),
    nextAction:
      "Inspect the current supported repository setup, then prepare this same app's changes normally. Repairs within the same accepted behavior retain their existing approved repair path. A different new proposal requires its normal current Build approval; validation, review and publication approval bind the current changed code. The app, repository destination and runtime data are unchanged.",
  };
};
