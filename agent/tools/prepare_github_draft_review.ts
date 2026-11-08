import { parseRepositoryReference } from "@/lib/integrations/repository-access";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { observeNormalizedChangeSet, reviewableChanges } from "./change_set_status";
import { readPreparedSandboxSourceManifest } from "@/lib/repository/supported-template";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  appBuilderWorkflowState,
  updateExactWorkflow,
  invalidateGitHubDestinationReview,
  assertExactWorkflowState,
} from "@/lib/agent/workflow-state";
import type { OverlayFile } from "@/lib/repository/target-apply";
import { createGitHubDestinationReviewBinding } from "@/lib/repository/github-destination-review";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { checkedNativeToolResult } from "@/lib/eve/payload-envelope";
import { resolvePublicationTargetForTool } from "@/lib/agent/github-publication-destination";
import {
  priorResumedBuildDraftProposal,
  priorOwnedAppDraftPublication,
} from "@/lib/agent/existing-app-repair-planning";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";

export const initialDraftCandidatePaths = async (
  input: Parameters<typeof observeNormalizedChangeSet>[0] & {
    reviewedPaths: readonly string[];
    observed: Awaited<ReturnType<typeof observeNormalizedChangeSet>>["observed"];
  },
  readOriginal = readPreparedSandboxSourceManifest,
  ownedMergedAppRevision = false,
) => {
  const { state, observed } = input;
  if (ownedMergedAppRevision) {
    const candidatePaths = [...new Set(input.reviewedPaths)];
    if (
      candidatePaths.length === 0 ||
      candidatePaths.some((path) => !path.startsWith(`apps/${state.appSpec.appId}/`))
    ) {
      throw new Error("An owned app revision must contain only that app's changed files.");
    }
    return { candidatePaths, retainedRegistration: new Map<string, string>() };
  }
  const candidatePaths = new Set(
    state.githubDestinationReview?.candidatePaths ?? input.reviewedPaths,
  );
  const retainedRegistration = new Map<string, string>();
  if (state.sourceReceipt.sourceKind === "fresh-template") {
    const appFiles = reviewableChanges(
      observed.files.map(({ path }) => ({ path, kind: "added" as const })),
      state.appSpec.appId,
      true,
    );
    // A later repair can reset the local before-tree to an already-scaffolded app.
    if (appFiles.some(({ path }) => !candidatePaths.has(path))) {
      const original = await readOriginal(input.sandbox, state.workspace);
      const originalDigests = new Map(original.map(({ path, sha256 }) => [path, sha256]));
      const registrationPaths = new Set([
        "package.json",
        "bun.lock",
        state.applyReceipt.targetReceipt.topology.path,
      ]);
      for (const { path, digest } of observed.files) {
        if (registrationPaths.has(path) && originalDigests.get(path) !== digest) {
          retainedRegistration.set(path, originalDigests.get(path) ?? "");
          candidatePaths.add(path);
        }
      }
      for (const { path } of appFiles) {
        candidatePaths.add(path);
      }
    }
  }
  return { candidatePaths: [...candidatePaths], retainedRegistration };
};

const assertRetainedRegistrationUnchanged = (
  retainedRegistration: ReadonlyMap<string, string>,
  destinationFiles: readonly OverlayFile[],
  authoredFiles: readonly OverlayFile[],
) => {
  for (const [path, baseline] of retainedRegistration) {
    const current = destinationFiles.find((file) => file.path === path)?.digest ?? "";
    const authored = authoredFiles.find((file) => file.path === path)?.digest;
    if (current !== baseline && current !== authored) {
      throw new Error(
        `The destination changed ${path} since the app was built. Reconcile the app registration with the current destination before review.`,
      );
    }
  }
};

export default defineTool({
  description:
    "Prepare a new draft-PR review against the recorded repository's current default branch. After this same app's owned PR has merged, reuse its saved session and private workspace to review the app's new changes; Builder verifies the prior publication without replacing source or app resources. An open or uncertain prior publication still requires its existing update or reconciliation workflow. For a new app with no destination, follow the returned destination setup link for this same saved build. Supply destination only when the user explicitly chose an existing repository. Preserve the validated private app and original source provenance while invalidating the old review and seal. Use change_set_status with contentSide before or after to inspect destination content as needed. Then accept_change_set, seal the new proposal, and request separate publication approval. This never writes GitHub or updates an existing PR.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed") {
      throw new Error("Validate the app before preparing a destination review.");
    }
    const retainedPublication = priorOwnedAppDraftPublication(
      state,
      ctx.session.id,
      draftReconciliationState.get(),
    );
    const updatingExistingDraft =
      state.phase === "reviewed" && state.existingDraftUpdate !== undefined;
    if (
      (state.publishedGitHubDraftProposalDigest !== undefined || updatingExistingDraft) &&
      retainedPublication === undefined
    ) {
      throw new Error(
        "Use the existing draft update or reconciliation workflow for an existing PR.",
      );
    }
    const resolved = await resolvePublicationTargetForTool({
      ctx,
      appId: state.appSpec.appId,
      destination:
        input.destination === undefined
          ? undefined
          : {
              ...input.destination,
              repository: parseRepositoryReference(input.destination.repository).fullName,
            },
      destinationReview: state.githubDestinationReview,
      githubSource: state.githubSource,
      sourceKind: state.sourceReceipt.sourceKind,
    });
    if (resolved.kind === "selection") {
      return resolved.access;
    }
    if (resolved.kind === "missing") {
      return resolved.guidance;
    }
    const { target } = resolved;
    const sandbox = await ctx.getSandbox();
    const { changeSet, observed } = await observeNormalizedChangeSet({ sandbox, state });
    const pathInput = {
      sandbox,
      state,
      observed,
      reviewedPaths: changeSet.approvedPaths,
    };
    const runtime =
      target.destination === undefined
        ? await githubPublicationRuntimeForSession(ctx.session.auth)
        : await githubPublicationRuntimeForSession(ctx.session.auth, {
            selectedInstallationId: target.destination.installationId,
          });
    if (runtime.inspectDraftDestination === undefined) {
      throw new Error("The GitHub runtime does not support destination reviews.");
    }
    if (retainedPublication !== undefined && runtime.inspectPriorAppPublication === undefined) {
      throw new Error("The GitHub runtime cannot inspect this app's prior publication.");
    }
    const prior =
      retainedPublication !== undefined &&
      (await runtime.inspectPriorAppPublication?.(retainedPublication.proposal)) === "recorded"
        ? retainedPublication
        : undefined;
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), state, "publication lookup");
    if (updatingExistingDraft && prior === undefined) {
      throw new Error(
        "Use the existing draft update or reconciliation workflow for an existing PR.",
      );
    }
    let selectedPaths =
      prior === undefined ? await initialDraftCandidatePaths(pathInput) : undefined;
    const destination = await runtime.inspectDraftDestination({
      existingProposal:
        (state.phase === "reviewed" ? state.githubDraftProposal?.proposal : undefined) ??
        retainedPublication?.proposal ??
        priorResumedBuildDraftProposal(state, ctx.session.id),
      ...(prior === undefined
        ? {}
        : {
            ownedAppRevision: {
              appId: state.appSpec.appId,
              proposal: prior.proposal,
              installationId: prior.installationId,
              ...(prior.reconciliation === undefined
                ? {}
                : { reconciliation: prior.reconciliation }),
            },
            prepareCandidatePaths: async (ownedMergedPublication: boolean) => {
              ctx.abortSignal?.throwIfAborted();
              assertExactWorkflowState(
                appBuilderWorkflowState.get(),
                state,
                "revision preparation",
              );
              selectedPaths = await initialDraftCandidatePaths(
                {
                  ...pathInput,
                  reviewedPaths: [...pathInput.reviewedPaths, ...(prior.appChangedPaths ?? [])],
                },
                undefined,
                ownedMergedPublication,
              );
              return selectedPaths.candidatePaths;
            },
          }),
      ...target,
      paths: selectedPaths?.candidatePaths ?? [],
    });
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(
      appBuilderWorkflowState.get(),
      state,
      "destination review preparation",
    );
    if (selectedPaths === undefined) {
      throw new Error("The publication runtime did not prepare this revision's paths.");
    }
    if (
      state.publishedGitHubDraftProposalDigest !== undefined &&
      destination.ownedMergedPublicationDigest !== state.publishedGitHubDraftProposalDigest
    ) {
      throw new Error("Recover the current publication before preparing another app revision.");
    }
    const { candidatePaths, retainedRegistration } = selectedPaths;
    assertExistingAppReviewScope(
      { approvedPaths: candidatePaths, sourceSha: changeSet.sourceSha },
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    assertRetainedRegistrationUnchanged(retainedRegistration, destination.preTree, observed.files);
    const binding = createGitHubDestinationReviewBinding({
      ...destination,
      applyDigest: state.applyReceipt.digest,
      candidatePaths,
      postTreeDigest: changeSet.postTreeDigest,
      validationDigest: state.validationReceipt.digest,
    });
    updateExactWorkflow({
      expected: state,
      operation: "destination review preparation",
      transition: () => {
        const next = invalidateGitHubDestinationReview(state, binding);
        if (destination.ownedMergedPublicationDigest !== undefined) {
          Reflect.deleteProperty(next, "publishedGitHubDraftProposalDigest");
        }
        return next;
      },
    });
    return checkedNativeToolResult(
      {
        branch: binding.repository.defaultBranch,
        candidatePathCount: binding.candidatePaths.length,
        destinationReviewDigest: binding.digest,
        destinationReviewReference: {
          digest: binding.digest,
          kind: "current-session-destination-review",
          sessionId: ctx.session.id,
        },
        destinationSha: binding.repository.headSha,
        destinationTree: binding.repository.headTree,
        next: 'Inspect destination content as needed with change_set_status view="next-page" and contentSide="before" or "after"; view="read-progress" reports optional inspection progress. Then accept_change_set, seal_github_draft_pr_proposal, and request publication approval.',
        originalSourceSha: state.githubSource?.resolvedSha ?? state.sourceReceipt.sourceSha,
        repository: `${binding.repository.owner}/${binding.repository.name}`,
        status: "destination-review-required",
      },
      { callId: ctx.callId, toolName: "prepare_github_draft_review", turnId: ctx.session.turn.id },
    );
  },
  inputSchema: z.strictObject({
    destination: z
      .strictObject({
        repository: z.string().min(3).max(221),
        selectedInstallationId: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .nullable()
          .optional(),
      })
      .optional(),
  }),
});
