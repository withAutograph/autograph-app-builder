import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import { githubSandboxCredentialPolicy } from "@/lib/repository/github-sandbox-credentials";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { prepareDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import type { DraftReconciliationInput } from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  description:
    "Fetch the live base and existing draft head into an isolated Builder checkout and prepare a non-force merge candidate. This does not update GitHub. It reports exact app-owned conflict paths and refuses platform-owned conflicts.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "reviewed" ||
      state.githubSource === undefined ||
      state.sourceReceipt.sourceKind !== "existing-repository"
    ) {
      throw new Error(
        "Review the selected existing app and its current source before preparing a draft PR reconciliation.",
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
    );
    const sandbox = await getSourceBoundSandbox(ctx);
    const accessReceipt = repositoryAccessReceiptState.get();
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- bind all access receipt dimensions to this session and repository.
      accessReceipt === undefined ||
      accessReceipt.sessionId !== ctx.session.id ||
      accessReceipt.repository.repositoryId !== state.githubSource.repository.repositoryId ||
      accessReceipt.repository.owner !== state.githubSource.repository.owner ||
      accessReceipt.repository.name !== state.githubSource.repository.name
    ) {
      throw new Error(
        "Builder cannot fetch the current draft and base: the selected repository no longer matches its verified GitHub access. Reconnect this repository, then retry reconciliation.",
      );
    }
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    const source = await runtime.inspectExistingDraftReconciliationSource({
      name: state.githubSource.repository.name,
      owner: state.githubSource.repository.owner,
      pullRequestNumber: input.pullRequestNumber,
      repositoryId: state.githubSource.repository.repositoryId,
    });
    if (state.githubSource.resolvedRef !== `refs/heads/${source.draft.headBranch}`) {
      throw new Error(
        "The selected Builder source is not this draft PR branch. Select that branch as the existing app source, then retry reconciliation.",
      );
    }
    const original = draftReconciliationState.get();
    const unpublished =
      state.reviewReceipt.changes.length === 0
        ? undefined
        : {
            changes: state.reviewReceipt.changes,
            contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
            reviewDigest: state.reviewReceipt.digest,
          };
    const request: DraftReconciliationInput = {
      appId: state.appSpec.appId,
      baseBranch: source.draft.baseBranch,
      baseSha: source.base.headSha,
      headBranch: source.draft.headBranch,
      headSha: source.draft.headSha,
      repository: {
        name: state.githubSource.repository.name,
        owner: state.githubSource.repository.owner,
      },
      sandbox,
    };
    if (unpublished !== undefined) {
      request.unpublished = unpublished;
    }
    const accessRuntime = await repositoryAccessRuntimeForSession(ctx.session.auth);
    const credential = await accessRuntime.acquireExistingSourceCredential({
      installationId: accessReceipt.scope.installationId,
      repository: {
        name: accessReceipt.repository.name,
        owner: accessReceipt.repository.owner,
        repositoryId: accessReceipt.repository.repositoryId,
      },
      sessionId: accessReceipt.sessionId,
    });
    let prepared: Awaited<ReturnType<typeof prepareDraftReconciliation>>;
    try {
      await sandbox.setNetworkPolicy(githubSandboxCredentialPolicy(credential.token));
      prepared = await prepareDraftReconciliation(request);
    } finally {
      await sandbox.setNetworkPolicy("allow-all");
    }
    const candidate = {
      ...prepared,
      githubSourceDigest: state.githubSource.digest,
      originalReviewDigest: state.reviewReceipt.digest,
      pullRequestNumber: input.pullRequestNumber,
      repositoryId: state.githubSource.repository.repositoryId,
      version: 1 as const,
    };
    updateExactDraftReconciliation({
      expected: original,
      operation: "preparing the isolated merge candidate",
      transition: () => candidate,
    });
    return {
      baseSha: prepared.baseSha,
      conflicts: prepared.conflicts,
      headSha: prepared.headSha,
      root: prepared.root,
      status: prepared.conflicts.length === 0 ? "ready_for_validation" : "needs_resolution",
    };
  },
  inputSchema: z.strictObject({ pullRequestNumber: z.number().int().positive() }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
