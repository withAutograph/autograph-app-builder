/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
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
import type { FirstAppRegistration } from "@/lib/repository/github-destination-review";
import {
  acquiredSourceLacksApp,
  planFirstAppPublicationComposition,
} from "@/lib/repository/first-app-publication-composition";
import { inspectApplyOverlay, reviewedOverlayTreeDigest } from "@/lib/repository/target-apply";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { checkedNativeToolResult } from "@/lib/eve/payload-envelope";
import { resolvePublicationTargetForTool } from "@/lib/agent/github-publication-destination";
import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { prepareWithVerifiedGitHubFetchRecovery } from "@/lib/agent/verified-github-fetch-recovery";
import { setBuilderSandboxNetworkPolicy } from "@/lib/sandbox/builder-sandbox";
import {
  firstPublicationFrameworkVersions,
  priorResumedBuildDraftProposal,
  priorOwnedAppDraftPublication,
} from "@/lib/agent/existing-app-repair-planning";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { ownedDraftPublicationHistory } from "@/lib/agent/github-draft-publication-lineage";
import { OwnedOpenDraftReviewRequiredError } from "@/lib/agent/github-publication-runtime";
import type {
  GitHubPublicationRuntime,
  OwnedAppRevisionLookup,
} from "@/lib/agent/github-publication-runtime";

const firstPublicationPaths = ["package.json", "microfrontends.json", "bun.lock"];

export const initialDraftCandidatePaths = async (
  input: Parameters<typeof observeNormalizedChangeSet>[0] & {
    reviewedPaths: readonly string[];
    observed: Awaited<ReturnType<typeof observeNormalizedChangeSet>>["observed"];
  },
  readOriginal = readPreparedSandboxSourceManifest,
  ownedMergedAppRevision = false,
  includeFreshRegistration = false,
) => {
  const { state, observed } = input;
  const appFiles = reviewableChanges(
    observed.files.map(({ path }) => ({ path, kind: "added" as const })),
    state.appSpec.appId,
    true,
  );
  if (ownedMergedAppRevision) {
    const candidatePaths = [
      ...new Set([...input.reviewedPaths, ...appFiles.map(({ path }) => path)]),
    ].filter((path) => path.startsWith(`apps/${state.appSpec.appId}/`));
    if (candidatePaths.length === 0) {
      throw new Error("An owned app revision must contain only that app's changed files.");
    }
    return { candidatePaths, retainedRegistration: new Map<string, string>() };
  }
  const candidatePaths = new Set(
    state.githubDestinationReview?.candidatePaths ?? input.reviewedPaths,
  );
  const retainedRegistration = new Map<string, string>();
  // A later repair can reset the local before-tree to an already-scaffolded app.
  if (
    state.sourceReceipt.sourceKind === "fresh-template" &&
    (includeFreshRegistration || appFiles.some(({ path }) => !candidatePaths.has(path)))
  ) {
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
    "Prepare a new draft-PR review against the recorded repository's current default branch. After this same app's owned PR has merged or closed, reuse its saved session and private workspace to review the app's new changes; Builder reads the retained publication from its owned journal even after validation discarded the old review. For its verified open draft, follow the returned nextCall: accept the current app delta, then prepare reconciliation for that same server-observed PR without a recovery flag. That app review does not require another initial destination review. Uncertain prior publication still requires its existing recovery. For a new app with no destination, follow the returned destination setup link for this same saved build. Supply destination only when the user explicitly chose an existing repository. If the new app was built in an acquired checkout of that repository, this tool verifies the app is absent from the acquired source and destination, then prepares only its app files and repository-generated registration. Preserve the validated private app and original source provenance while invalidating the old review and seal. Use change_set_status with contentSide before or after to inspect destination content as needed. Then accept_change_set, seal the new proposal, and request separate publication approval. This never writes GitHub or updates an existing PR.",
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
    let prior =
      retainedPublication !== undefined &&
      (await runtime.inspectPriorAppPublication?.(retainedPublication.proposal)) === "recorded"
        ? retainedPublication
        : undefined;
    if (
      prior === undefined &&
      state.publishedGitHubDraftProposalDigest === undefined &&
      target.githubSource !== undefined
    ) {
      const history = ownedDraftPublicationHistory({
        ...target.githubSource.repository,
        sessionId: ctx.session.id,
        appId: state.appSpec.appId,
      });
      for (const seal of history) {
        if (runtime.inspectPriorAppPublication === undefined) {
          throw new Error("The GitHub runtime cannot inspect this app's prior publication.");
        }
        ctx.abortSignal?.throwIfAborted();
        // oxlint-disable-next-line eslint/no-await-in-loop -- The newest recorded publication is the one to reconcile; later seals may not have been submitted.
        if ((await runtime.inspectPriorAppPublication(seal.proposal)) === "recorded") {
          prior = seal;
          break;
        }
      }
    }
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), state, "publication lookup");
    if (
      updatingExistingDraft &&
      prior === undefined &&
      state.publishedGitHubDraftProposalDigest === undefined
    ) {
      throw new Error(
        "Use the existing draft update or reconciliation workflow for an existing PR.",
      );
    }
    const publishedProposalDigest =
      prior?.proposal.digest ?? state.publishedGitHubDraftProposalDigest;
    const { changeSet, observed } = await observeNormalizedChangeSet({
      sandbox,
      state,
      destinationReview:
        state.githubDestinationReview === undefined ? undefined : "observe-current-edits",
    });
    const { appId } = state.appSpec;
    const { githubSource } = state;
    const baseline = appBaselineState.get();
    const mayBeFirstPublication = [
      publishedProposalDigest === undefined,
      state.sourceReceipt.sourceKind === "existing-repository",
      baseline === undefined,
      observed.files.some(({ path }) => path === `apps/${appId}/package.json`),
    ].every(Boolean);
    const acquired =
      mayBeFirstPublication && githubSource !== undefined
        ? { sha: githubSource.resolvedSha, tree: githubSource.resolvedTree }
        : undefined;
    const firstPublication =
      acquired !== undefined &&
      (await acquiredSourceLacksApp({ acquired, appId, sandbox, signal: ctx.abortSignal }));
    const pathInput = {
      sandbox,
      state,
      observed,
      reviewedPaths: changeSet.approvedPaths,
    };
    let ownedAppRevision: OwnedAppRevisionLookup | undefined;
    if (publishedProposalDigest !== undefined) {
      ownedAppRevision = { appId: state.appSpec.appId, proposalDigest: publishedProposalDigest };
      if (prior !== undefined) {
        ownedAppRevision.proposal = prior.proposal;
        ownedAppRevision.installationId = prior.installationId;
        if (prior.reconciliation !== undefined) {
          ownedAppRevision.reconciliation = prior.reconciliation;
        }
      } else if (target.destination !== undefined) {
        ownedAppRevision.installationId = target.destination.installationId;
      }
    }
    let selectedPaths =
      publishedProposalDigest === undefined
        ? await initialDraftCandidatePaths(pathInput)
        : undefined;
    if (firstPublication) {
      selectedPaths = {
        candidatePaths: [
          ...reviewableChanges(
            observed.files.map(({ path }) => ({ kind: "added" as const, path })),
            appId,
            true,
          ).map(({ path }) => path),
          ...firstPublicationPaths,
        ],
        retainedRegistration: new Map(),
      };
    }
    let destination: Awaited<
      ReturnType<NonNullable<GitHubPublicationRuntime["inspectDraftDestination"]>>
    >;
    const currentProposal =
      state.phase === "reviewed" ? state.githubDraftProposal?.proposal : undefined;
    try {
      destination = await runtime.inspectDraftDestination({
        existingProposal:
          prior?.proposal ??
          currentProposal ??
          retainedPublication?.proposal ??
          priorResumedBuildDraftProposal(state, ctx.session.id),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
        ...(publishedProposalDigest === undefined
          ? {}
          : {
              ownedAppRevision,
              prepareCandidatePaths: async (
                ownedMergedPublication: boolean,
                publishedPaths: readonly string[],
              ) => {
                ctx.abortSignal?.throwIfAborted();
                assertExactWorkflowState(
                  appBuilderWorkflowState.get(),
                  state,
                  "revision preparation",
                );
                selectedPaths = await initialDraftCandidatePaths(
                  {
                    ...pathInput,
                    reviewedPaths: [
                      ...pathInput.reviewedPaths,
                      ...(prior?.appChangedPaths ?? []),
                      ...(ownedMergedPublication
                        ? publishedPaths.filter((path) =>
                            path.startsWith(`apps/${state.appSpec.appId}/`),
                          )
                        : []),
                    ],
                  },
                  undefined,
                  ownedMergedPublication,
                  !ownedMergedPublication,
                );
                return selectedPaths.candidatePaths;
              },
            }),
        ...target,
        paths: selectedPaths?.candidatePaths ?? [],
      });
    } catch (error) {
      ctx.abortSignal?.throwIfAborted();
      assertExactWorkflowState(appBuilderWorkflowState.get(), state, "publication lookup");
      if (!(error instanceof OwnedOpenDraftReviewRequiredError)) {
        throw error;
      }
      const { subject } = error;
      const repositoryId =
        target.destination === undefined
          ? target.githubSource.repository.repositoryId
          : target.destination.repositoryId;
      const sameOwnedPublication = [
        ownedAppRevision !== undefined,
        subject.appId === state.appSpec.appId,
        subject.proposalDigest === ownedAppRevision?.proposalDigest,
        subject.repositoryId === repositoryId,
        ownedAppRevision?.installationId === undefined ||
          subject.installationId === ownedAppRevision.installationId,
      ].every(Boolean);
      if (!sameOwnedPublication) {
        throw new Error("The owned draft continuation changed its app or repository binding.", {
          cause: error,
        });
      }
      const reconciliation = {
        tool: "prepare_github_draft_pr_reconciliation" as const,
        input: { pullRequestNumber: subject.pullRequestNumber },
      };
      const currentReviewMatches =
        state.phase === "reviewed" &&
        state.githubDestinationReview === undefined &&
        state.reviewReceipt.changeSetDigest === changeSet.digest;
      const refreshReview =
        !currentReviewMatches &&
        (state.phase === "reviewed" || state.githubDestinationReview !== undefined);
      if (refreshReview || state.publishedGitHubDraftProposalDigest !== subject.proposalDigest) {
        updateExactWorkflow({
          expected: state,
          operation: "recovering the current review for this owned draft",
          transition: () => ({
            ...(refreshReview ? invalidateGitHubDestinationReview(state) : state),
            publishedGitHubDraftProposalDigest: subject.proposalDigest,
          }),
        });
      }
      return checkedNativeToolResult(
        {
          status: "existing-draft-review-required",
          appId: subject.appId,
          pullRequestNumber: subject.pullRequestNumber,
          nextCall: currentReviewMatches
            ? reconciliation
            : { tool: "accept_change_set" as const, input: {} },
          afterReview: reconciliation,
          guidance:
            "Preserve this app's current validated bytes, source and owned draft. Review the current app delta with accept_change_set, then follow afterReview to prepare that same draft's normal reconciliation without a recovery flag. Do not prepare a replacement PR or initial destination review. Candidate validation, review and separate exact update approval remain required before publication.",
        },
        {
          callId: ctx.callId,
          toolName: "prepare_github_draft_review",
          turnId: ctx.session.turn.id,
        },
      );
    }
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
      destination.ownedCompletedPublicationDigest !== state.publishedGitHubDraftProposalDigest
    ) {
      throw new Error("Recover the current publication before preparing another app revision.");
    }
    let { candidatePaths } = selectedPaths;
    const { retainedRegistration } = selectedPaths;
    assertRetainedRegistrationUnchanged(retainedRegistration, destination.preTree, observed.files);
    let { postTreeDigest } = changeSet;
    let firstAppRegistration: FirstAppRegistration | undefined;
    if (firstPublication && acquired !== undefined) {
      const frameworkUpgrade = firstPublicationFrameworkVersions(state, ctx.session.id);
      const files = await planFirstAppPublicationComposition({
        acquired,
        appId,
        applyRoot: state.applyReceipt.applyRoot,
        destination: destination.repository,
        frameworkUpgrade,
        sandbox,
        signal: ctx.abortSignal,
        withDestinationFetch: async (fetch) => {
          const access = await repositoryAccessRuntimeForSession(ctx.session.auth);
          await prepareWithVerifiedGitHubFetchRecovery({
            acquireCredential: async () =>
              await access.acquireExistingSourceCredential({
                installationId: destination.installation.installationId,
                repository: destination.repository,
                sessionId: ctx.session.id,
              }),
            prepare: fetch,
            sandbox: {
              setNetworkPolicy: async (policy) => {
                await setBuilderSandboxNetworkPolicy(sandbox, policy);
              },
            },
          });
        },
      });
      ctx.abortSignal?.throwIfAborted();
      assertExactWorkflowState(appBuilderWorkflowState.get(), state, "first app registration");
      const root = state.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
      const paths = files.map(({ path }) => path);
      const registeredPaths = new Set<string>(paths);
      candidatePaths = candidatePaths.filter(
        (path) => path.startsWith(`apps/${appId}/`) || registeredPaths.has(path),
      );
      firstAppRegistration = { appId, paths };
      if (frameworkUpgrade !== undefined) {
        firstAppRegistration.frameworkUpgrade = frameworkUpgrade;
      }
      for (const file of files) {
        ctx.abortSignal?.throwIfAborted();
        // oxlint-disable-next-line eslint/no-await-in-loop -- Finish one private registration write before checking cancellation and starting the next.
        await sandbox.writeTextFile({ content: file.content, path: `${root}/${file.path}` });
      }
      const staged = await inspectApplyOverlay(sandbox, state.applyReceipt.applyRoot);
      if (
        reviewedOverlayTreeDigest(staged, appId, true) !==
          reviewedOverlayTreeDigest(observed, appId, true) ||
        files.some(
          ({ path, digest, mode }) =>
            !staged.files.some(
              (file) => file.path === path && file.digest === digest && file.mode === mode,
            ),
        )
      ) {
        throw new Error(
          "The app or generated registration changed during first publication review.",
        );
      }
      postTreeDigest = reviewedOverlayTreeDigest(staged, appId, true, false, paths);
    }
    assertExistingAppReviewScope(
      {
        approvedPaths: candidatePaths,
        frameworkUpgrade:
          firstAppRegistration === undefined ? changeSet.frameworkUpgrade : undefined,
        sourceSha: changeSet.sourceSha,
      },
      appId,
      state.sourceReceipt.sourceKind,
      baseline?.receipt,
      firstAppRegistration?.paths,
    );
    const draftReview: Parameters<typeof createGitHubDestinationReviewBinding>[0] = {
      ...destination,
      applyDigest: state.applyReceipt.digest,
      candidatePaths,
      postTreeDigest,
      validationDigest: state.validationReceipt.digest,
    };
    if (firstAppRegistration !== undefined) {
      const approvedPaths = new Set(candidatePaths);
      draftReview.firstAppRegistration = firstAppRegistration;
      draftReview.preTree = destination.preTree.filter(({ path }) => approvedPaths.has(path));
    }
    const binding = createGitHubDestinationReviewBinding(draftReview);
    updateExactWorkflow({
      expected: state,
      operation: "destination review preparation",
      transition: () => {
        const next = invalidateGitHubDestinationReview(state, binding);
        if (destination.ownedCompletedPublicationDigest !== undefined) {
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
        nextCall: { tool: "accept_change_set" as const, input: {} },
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
