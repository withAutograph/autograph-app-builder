import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { sha256 } from "@/lib/agent/workflow-state";
import { hasTestCapability } from "@/lib/testing/test-capability";

const testModel = mockModel(({ lastUserMessage, toolResults }) => {
  const message = (lastUserMessage ?? "").toLowerCase();
  if (message.includes("record three prototype artifacts in parallel")) {
    const recorded = toolResults.filter(
      ({ name }) => name === "record_prototype_artifact",
    );
    if (recorded.length === 0)
      return {
        toolCalls: [
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/parallel-proof/app-spec.md",
              mediaType: "text/markdown",
              content: "# Build handoff\n",
            },
          },
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/parallel-proof/decisions.md",
              mediaType: "text/markdown",
              content: "# Decisions\n",
            },
          },
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/parallel-proof/index.html",
              mediaType: "text/html",
              content: "<!doctype html><title>Proof</title>",
            },
          },
        ],
      };
    return recorded.length === 3 && recorded.every(({ isError }) => !isError)
      ? "All three prototype artifacts were recorded."
      : "The parallel prototype artifact batch did not settle atomically.";
  }
  if (message.includes("github publication status")) {
    const result = toolResults.at(-1);
    if (result?.name !== "github_publication_status")
      return { toolCalls: [{ name: "github_publication_status", input: {} }] };
    if (result.isError)
      return "The typed GitHub publication status could not be verified.";
    const status = result.output as
      | {
          enabled?: boolean;
          adapterConfigured?: boolean;
          genericShellAuthority?: boolean;
          liveGitHubCallsAvailable?: boolean;
          reason?: string;
        }
      | undefined;
    return status?.enabled === false &&
      status.adapterConfigured === false &&
      status.genericShellAuthority === false &&
      status.liveGitHubCallsAvailable === false
      ? `GitHub publication is fail-closed: ${status.reason ?? "no typed adapter is configured."}`
      : "GitHub publication status did not prove the required fail-closed boundary.";
  }
  if (message.includes("report artifact workflow status")) {
    const result = toolResults.at(-1);
    if (result?.name !== "artifact_workflow_status")
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    return result.isError
      ? "The artifact workflow status could not be verified."
      : `Artifact workflow status: ${JSON.stringify(result.output)}`;
  }
  if (message.includes("retry target planning")) {
    const stale = message.includes("stale");
    const planResults = toolResults.filter(
      ({ name }) => name === "plan_app_creation",
    );
    const requiredResults = stale ? 3 : 2;
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      statusResult === undefined ||
      (planResults.length < requiredResults &&
        toolResults.at(-1)?.name === "plan_app_creation")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { appSpec?: { digest?: string }; phase?: string } | undefined;
    if (status?.phase !== "planned" || status.appSpec?.digest === undefined)
      return "A completed target plan is required before retry.";
    const planResult = planResults.at(-1);
    if (planResults.length < requiredResults)
      return {
        toolCalls: [
          {
            name: "plan_app_creation",
            input: {
              expectedAppSpecDigest: stale
                ? "0".repeat(64)
                : status.appSpec.digest,
            },
          },
        ],
      };
    if (planResult === undefined)
      return "The target-planning retry result is unavailable.";
    if (planResult.isError)
      return "The stale target-planning retry was rejected without changing its durable receipt.";
    const output = planResult.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable target-planning receipt without rerunning either target command."
      : "The target-planning retry did not reuse its durable receipt.";
  }
  if (message.includes("prepare offline target dependencies")) {
    const stale = message.includes("stale appspec digest");
    const lostResponse = message.includes("lost response");
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    const observedPhase = (
      statusResult?.output as { phase?: string } | undefined
    )?.phase;
    if (
      statusResult === undefined ||
      (observedPhase !== "app_spec_accepted" &&
        observedPhase !== "dependencies_prepared" &&
        toolResults.at(-1)?.name !== "workspace_status")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { appSpec?: { digest?: string }; phase?: string } | undefined;
    if (
      status?.phase !== "app_spec_accepted" &&
      status?.phase !== "dependencies_prepared"
    )
      return "An accepted AppSpec is required before dependency preparation.";
    if (status.appSpec?.digest === undefined)
      return "The accepted AppSpec digest is unavailable.";
    const preparations = toolResults.filter(
      ({ name }) => name === "prepare_target_dependencies",
    );
    const requiredResults = stale ? 3 : lostResponse ? 2 : 1;
    if (preparations.length < requiredResults)
      return {
        toolCalls: [
          {
            name: "prepare_target_dependencies",
            input: {
              expectedAppSpecDigest: stale
                ? "0".repeat(64)
                : status.appSpec.digest,
            },
          },
        ],
      };
    const preparation = preparations.at(-1);
    if (preparation === undefined)
      return "The dependency-preparation result is unavailable.";
    if (preparation.isError)
      return stale
        ? "Stale offline dependency preparation was rejected; the exact durable receipt was preserved."
        : "Offline dependency preparation was canceled or rejected; accepted AppSpec state was preserved.";
    const output = preparation.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable dependency-preparation receipt after re-verifying the cache."
      : "The approved target-bound offline dependency closure was verified and materialized only in builder-owned planning metadata; request target planning separately.";
  }
  if (message.includes("run target identity and planning")) {
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      statusResult === undefined ||
      ((statusResult.output as { phase?: string } | undefined)?.phase !==
        "dependencies_prepared" &&
        toolResults.at(-1)?.name !== "workspace_status")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { appSpec?: { digest?: string }; phase?: string } | undefined;
    if (
      status?.phase !== "dependencies_prepared" ||
      status.appSpec?.digest === undefined
    )
      return "Approved offline dependency preparation is required before target planning.";
    const latestResult = toolResults.at(-1);
    const planResult =
      latestResult?.name === "plan_app_creation" ? latestResult : undefined;
    if (planResult === undefined)
      return {
        toolCalls: [
          {
            name: "plan_app_creation",
            input: { expectedAppSpecDigest: status.appSpec.digest },
          },
        ],
      };
    return planResult.isError
      ? "Target identity and planning were canceled or rejected; no target mutation occurred."
      : "The approved fixed target identity and planning commands produced a digest-bound canonical proposal; no apply, validation, or target mutation ran.";
  }
  if (
    message.includes("apply the current creation proposal") ||
    message.includes("retry target apply") ||
    message.includes("apply with a stale proposal digest")
  ) {
    const stale = message.includes("stale proposal digest");
    const lostResponse = message.includes("lost response");
    const applications = toolResults.filter(
      ({ name }) => name === "apply_app_creation",
    );
    const requiredResults = stale ? 3 : lostResponse ? 2 : 1;
    const statusResults = toolResults.filter(
      ({ name }) => name === "workspace_status",
    );
    const latestStatus = statusResults.at(-1);
    const latestApplyIndex = toolResults.findLastIndex(
      ({ name }) => name === "apply_app_creation",
    );
    const latestPlanIndex = toolResults.findLastIndex(
      ({ name }) => name === "plan_app_creation",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "workspace_status",
    );
    if (
      latestStatus === undefined ||
      latestPlanIndex > latestStatusIndex ||
      (applications.length >= requiredResults &&
        latestApplyIndex > latestStatusIndex)
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = latestStatus.output as
      | {
          phase?: string;
          proposal?: { digest?: string };
          apply?: { status?: string };
        }
      | undefined;
    if (
      status?.phase !== "planned" &&
      status?.phase !== "apply_failed" &&
      status?.phase !== "applied"
    )
      return "A completed target plan is required before apply.";
    if (applications.length < requiredResults) {
      const proposalDigest = status.proposal?.digest;
      if (proposalDigest === undefined)
        return "The canonical proposal digest is unavailable.";
      return {
        toolCalls: [
          {
            name: "apply_app_creation",
            input: {
              expectedProposalDigest: stale ? "0".repeat(64) : proposalDigest,
            },
          },
        ],
      };
    }
    const result = applications.at(-1);
    if (result?.isError) {
      if (stale)
        return "Stale target apply was rejected without creating or changing an apply overlay.";
      if (status.phase === "apply_failed")
        return "Target apply recorded a recovery-required partial-failure receipt and will not retry automatically.";
      return "Target apply was canceled or rejected; the exact planned phase was preserved.";
    }
    const output = result?.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable target-apply receipt after verifying the post-apply overlay tree; the command was not rerun."
      : "The approved canonical proposal was applied only in a fresh builder-owned overlay and recorded with exact pre/post tree and changed-content digests. Validation, reviewed change-set generation, and publication did not run.";
  }
  if (
    message.includes("record a replacement prototype artifact") ||
    message.includes("retry recording the exact replacement prototype artifact")
  ) {
    const content = "replacement artifact";
    const digest = sha256(content);
    const results = toolResults.filter(
      ({ name }) => name === "record_prototype_artifact",
    );
    const latest = results.at(-1);
    const matching = results.filter(
      (result) =>
        !result.isError &&
        (result.output as { digest?: string } | undefined)?.digest === digest,
    );
    const requiredMatches = message.includes("retry recording") ? 2 : 1;
    const failedRecordings = results.filter(({ isError }) => isError).length;
    if (
      latest?.isError &&
      (!message.includes("retry recording") || failedRecordings >= 2)
    )
      return "Prototype artifact recording was canceled; durable state was not changed.";
    if (matching.length >= requiredMatches) {
      const output = matching.at(-1)?.output as
        { invalidated?: boolean; reused?: boolean } | undefined;
      if (output?.reused === true)
        return "The retry reused the exact stored artifact revision without changing durable state.";
      return output?.invalidated === true
        ? "The new artifact revision invalidated the accepted AppSpec and proposal."
        : "The new artifact revision was recorded.";
    }
    return {
      toolCalls: [
        {
          name: "record_prototype_artifact",
          input: {
            path: "prototype/expense-review/app-spec.md",
            mediaType: "text/markdown",
            content,
          },
        },
      ],
    };
  }
  if (
    message.includes("validate the applied creation") ||
    message.includes("retry target validation") ||
    message.includes("validate with a stale apply digest")
  ) {
    const stale = message.includes("stale apply digest");
    const lostResponse = message.includes("lost response");
    const validations = toolResults.filter(
      ({ name }) => name === "validate_app_creation",
    );
    const requiredResults = stale ? 3 : lostResponse ? 2 : 1;
    const statusResults = toolResults.filter(
      ({ name }) => name === "workspace_status",
    );
    const latestStatus = statusResults.at(-1);
    const latestValidationIndex = toolResults.findLastIndex(
      ({ name }) => name === "validate_app_creation",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "workspace_status",
    );
    if (
      latestStatus === undefined ||
      (validations.length >= requiredResults &&
        latestValidationIndex > latestStatusIndex)
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = latestStatus.output as
      | {
          phase?: string;
          apply?: { digest?: string };
        }
      | undefined;
    if (
      status?.phase !== "applied" &&
      status?.phase !== "validation_pending" &&
      status?.phase !== "validation_failed" &&
      status?.phase !== "validated"
    )
      return "An exact applied receipt is required before validation.";
    if (validations.length < requiredResults) {
      const applyDigest = status.apply?.digest;
      if (applyDigest === undefined)
        return "The exact apply receipt digest is unavailable.";
      return {
        toolCalls: [
          {
            name: "validate_app_creation",
            input: {
              expectedApplyDigest: stale ? "0".repeat(64) : applyDigest,
            },
          },
        ],
      };
    }
    const result = validations.at(-1);
    if (result?.isError) {
      if (stale)
        return "Stale target validation was rejected without creating a validation overlay.";
      if (status.phase === "validation_pending")
        return "The incomplete validation attempt is recovery-required and was not redispatched automatically.";
      if (status.phase === "validation_failed")
        return "Target validation recorded a recovery-required failure receipt and will not retry automatically.";
      return "Target validation was canceled or rejected; the exact applied phase was preserved.";
    }
    const output = result?.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable target-validation receipt after verifying the canonical applied tree; neither fixed command was rerun."
      : "The separately approved fixed check and test commands passed in independent builder-owned copies of the exact applied tree. The applied overlay remained unchanged; change review and publication did not run.";
  }
  if (
    message.includes("inspect the validated change set") ||
    message.includes("accept the displayed change set") ||
    message.includes("retry change-set acceptance") ||
    message.includes("accept a stale change set")
  ) {
    const stale = message.includes("stale change set");
    const retry = message.includes("retry change-set acceptance");
    const accepted = toolResults.filter(
      ({ name }) => name === "accept_change_set",
    );
    const requiredAccepts = stale ? 3 : retry ? 2 : 1;
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    const latestStatus = status?.output as
      { phase?: string; validation?: { digest?: string } } | undefined;
    if (
      status === undefined ||
      (latestStatus?.phase !== "validated" &&
        latestStatus?.phase !== "reviewed")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const proposal = [...toolResults]
      .reverse()
      .find(({ name }) => name === "change_set_status");
    if (proposal === undefined)
      return {
        toolCalls: [
          {
            name: "change_set_status",
            input: {
              expectedValidationDigest: latestStatus.validation?.digest,
            },
          },
        ],
      };
    if (message.includes("inspect the validated change set")) {
      if (proposal.isError)
        return "The exact validated change set could not be read.";
      const output = proposal.output as
        | {
            digest?: string;
            changes?: readonly unknown[];
            approvedPaths?: readonly string[];
          }
        | undefined;
      return `Validated change-set proposal: ${JSON.stringify({ digest: output?.digest, changes: output?.changes, approvedPaths: output?.approvedPaths })}. Review this exact ordered declarative change summary before requesting separate acceptance.`;
    }
    if (accepted.length < requiredAccepts) {
      const output = proposal.output as
        | {
            digest?: string;
            approvedPaths?: readonly string[];
            changes?: readonly unknown[];
          }
        | undefined;
      return {
        toolCalls: [
          {
            name: "accept_change_set",
            input: {
              changeSet: {
                digest: stale ? "0".repeat(64) : output?.digest,
                approvedPaths: output?.approvedPaths,
                changes: output?.changes,
              },
            },
          },
        ],
      };
    }
    const result = accepted.at(-1);
    if (result?.isError)
      return stale
        ? "The stale change-set proposal was rejected without changing the validated receipt."
        : "Change-set acceptance was canceled or rejected; the validated receipt was preserved.";
    const output = result?.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable reviewed change-set receipt without any target command, validation, or publication."
      : "The separately approved normalized change set was recorded from the exact canonical applied overlay. Publication did not run.";
  }
  if (
    message.includes("inspect fresh repository bootstrap at ") ||
    message.includes("publish fresh repository bootstrap at ")
  ) {
    const destinationPath = lastUserMessage?.match(
      /(?:inspect|publish) fresh repository bootstrap at (\/\S+)/iu,
    )?.[1];
    if (destinationPath === undefined)
      return "The fresh repository destination is missing.";
    const review = [...toolResults]
      .reverse()
      .find(({ name, isError }) => name === "accept_change_set" && !isError)
      ?.output as { digest?: string } | undefined;
    if (review?.digest === undefined)
      return "An exact accepted fresh-template change set is required.";
    const statusResults = toolResults.filter(
      ({ name }) => name === "fresh_bootstrap_status",
    );
    const status = statusResults.at(-1);
    if (
      status === undefined ||
      (message.includes("stale review") && statusResults.length < 2)
    )
      return {
        toolCalls: [
          {
            name: "fresh_bootstrap_status",
            input: {
              expectedReviewDigest: message.includes("stale review")
                ? "0".repeat(64)
                : review.digest,
              destinationPath,
              expectedPrestate: message.includes("exact-empty")
                ? "empty-directory"
                : "absent",
              repositoryIdentity: {
                initialBranch: "main",
                authorName: "Autograph App Builder",
                authorEmail: "app-builder@users.noreply.github.com",
                commitMessage: "Bootstrap repository",
                commitTimestamp: "2026-08-25T12:00:00-04:00",
              },
            },
          },
        ],
      };
    if (status.isError)
      return "Fresh repository bootstrap status was rejected without target mutation.";
    if (message.includes("inspect fresh repository bootstrap"))
      return `Fresh repository bootstrap proposal: ${JSON.stringify(status.output)}. Publication requires a separate approval.`;
    const publications = toolResults.filter(
      ({ name }) => name === "publish_fresh_repository",
    );
    if (publications.length === 0) {
      const publication = { ...(status.output as Record<string, unknown>) };
      delete publication.workflowPhase;
      delete publication.retryAllowed;
      delete publication.recoveryAllowed;
      delete publication.reused;
      return {
        toolCalls: [
          {
            name: "publish_fresh_repository",
            input: { publication },
          },
        ],
      };
    }
    const publication = publications.at(-1);
    if (publication?.isError)
      return "Fresh repository publication was canceled, stale, or recovery-required; no other publication tool was used.";
    return "The exact approved fresh-template result was atomically published as one parentless SHA-1 local repository with no remotes and release disabled.";
  }
  if (
    message.includes("recover fresh repository bootstrap") ||
    message.includes("retry fresh repository recovery after a lost response")
  ) {
    const latestRecoveryIndex = toolResults.findLastIndex(
      ({ name }) => name === "recover_fresh_repository",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "artifact_workflow_status",
    );
    if (
      message.includes("lost response") &&
      latestRecoveryIndex > latestStatusIndex
    )
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "artifact_workflow_status");
    if (status === undefined)
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    const workflow = status.output as
      | {
          phase?: string;
          freshBootstrap?: { digest?: string; proposalDigest?: string };
        }
      | undefined;
    if (
      workflow?.phase === "published_fresh_bootstrap" &&
      message.includes("lost response")
    )
      return "The lost-response recovery retry reused the exact durable fresh-bootstrap success receipt without redispatching recovery or another publication tool.";
    if (
      workflow?.phase !== "fresh_bootstrap_failed" ||
      workflow.freshBootstrap?.digest === undefined ||
      workflow.freshBootstrap.proposalDigest === undefined
    )
      return "An exact recovery-required fresh-bootstrap receipt is required.";
    const recoveries = toolResults.filter(
      ({ name }) => name === "recover_fresh_repository",
    );
    if (recoveries.length === 0)
      return {
        toolCalls: [
          {
            name: "recover_fresh_repository",
            input: {
              expectedJournalDigest: workflow.freshBootstrap.digest,
              expectedProposalDigest: workflow.freshBootstrap.proposalDigest,
            },
          },
        ],
      };
    const recovery = recoveries.at(-1);
    if (recovery?.isError)
      return "Fresh repository recovery was canceled or rejected; the exact recovery-required receipt remains authoritative.";
    return "The separately approved exact fresh-repository recovery completed without using another publication or mutation tool.";
  }
  if (
    message.includes("publish reviewed change set to a new branch worktree") ||
    message.includes(
      "publish reviewed change set with stale branch preconditions",
    ) ||
    message.includes(
      "retry branch worktree publication after a lost response",
    ) ||
    message.includes("recover branch worktree publication")
  ) {
    const stale = message.includes("stale branch preconditions");
    const recover = message.includes("recover branch worktree publication");
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "artifact_workflow_status");
    if (status === undefined)
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    const reviewDigest = (
      status.output as { review?: { digest?: string } } | undefined
    )?.review?.digest;
    if (reviewDigest === undefined)
      return "An exact reviewed receipt is required before branch-worktree publication.";
    const publicationStatuses = toolResults.filter(
      ({ name }) => name === "branch_worktree_publication_status",
    );
    const latestMutation = [...toolResults]
      .reverse()
      .find(
        ({ name }) =>
          name === "publish_reviewed_change_set_to_branch_worktree" ||
          name === "recover_branch_worktree_publication",
      );
    const latestMutationIndex = toolResults.findLastIndex(
      ({ name }) =>
        name === "publish_reviewed_change_set_to_branch_worktree" ||
        name === "recover_branch_worktree_publication",
    );
    const latestBranchStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "branch_worktree_publication_status",
    );
    const latestStatus = publicationStatuses.at(-1);
    if (
      latestStatus === undefined ||
      (latestMutation !== undefined &&
        latestBranchStatusIndex < latestMutationIndex)
    )
      return {
        toolCalls: [
          {
            name: "branch_worktree_publication_status",
            input: { expectedReviewDigest: reviewDigest },
          },
        ],
      };
    if (latestStatus.isError || latestStatus.output === undefined)
      return stale
        ? "Stale branch-worktree publication was rejected without creating a branch or worktree."
        : "Branch-worktree publication preconditions were rejected without mutating the source checkout.";
    const output = latestStatus.output as Record<string, unknown>;
    const proposal = { ...output };
    if (typeof proposal.proposalDigest === "string")
      proposal.digest = proposal.proposalDigest;
    for (const key of [
      "workflowPhase",
      "transactionWindow",
      "retryAllowed",
      "recoveryAllowed",
      "status",
      "proposalDigest",
      "publishedByCallId",
      "recoveryOfDigest",
      "branchCreated",
      "worktreeCreated",
      "appliedPaths",
      "recoveryRequired",
      "reason",
      "failureMessage",
      "worktreeRootIdentity",
      "worktreeGitDirectoryPath",
      "worktreeGitDirectoryIdentity",
      "worktreeHeadReference",
      "worktreeIndexFileDigest",
      "worktreeRemoteDigest",
      "worktreeStatusDigest",
      "postconditionDigest",
    ])
      delete proposal[key];
    if (recover) {
      if (output.status === "succeeded")
        return "The separately approved recovery completed the exact durable branch-worktree intent without a commit, push, remote publication, provider, deployment, or release action.";
      if (typeof output.digest !== "string")
        return "The exact durable recovery journal digest is unavailable.";
      if (toolResults.at(-1)?.name !== "recover_branch_worktree_publication")
        return {
          toolCalls: [
            {
              name: "recover_branch_worktree_publication",
              input: {
                publication: proposal,
                expectedJournalDigest: output.digest,
              },
            },
          ],
        };
      return latestMutation?.isError
        ? "Branch-worktree recovery was canceled or rejected; its exact durable receipt was preserved."
        : "The separately approved recovery completed the exact durable branch-worktree intent without a commit, push, remote publication, provider, deployment, or release action.";
    }
    if (output.status === "succeeded")
      return message.includes("retry branch worktree publication")
        ? "The exact durable branch-worktree publication receipt was verified and reused; no operation was redispatched."
        : "The separately approved reviewed change set was applied only in a new deterministic branch worktree. The original checkout was unchanged, and no commit, push, GitHub, provider, deployment, or release operation ran.";
    if (output.status === "pending" || output.status === "failed")
      return message.includes("retry branch worktree publication")
        ? "The durable branch-worktree publication attempt is recovery-required and was not redispatched automatically."
        : output.status === "failed"
          ? "Branch-worktree publication recorded a recovery-required partial-failure receipt and was not retried."
          : "The durable branch-worktree publication attempt is recovery-required and was not redispatched automatically.";
    if (
      latestMutation?.isError === true &&
      latestMutationIndex < latestBranchStatusIndex
    )
      return stale
        ? "Stale branch-worktree publication was rejected without creating a branch or worktree."
        : "Branch-worktree publication was canceled or rejected; the reviewed receipt was preserved.";
    if (latestMutationIndex < latestBranchStatusIndex)
      return {
        toolCalls: [
          {
            name: "publish_reviewed_change_set_to_branch_worktree",
            input: {
              publication: stale
                ? { ...proposal, sourceStatusDigest: "0".repeat(64) }
                : proposal,
            },
          },
        ],
      };
    if (latestMutation?.isError)
      return stale
        ? "Stale branch-worktree publication was rejected without creating a branch or worktree."
        : "Branch-worktree publication was canceled or rejected; the reviewed receipt was preserved.";
    const result = latestMutation?.output as { status?: string } | undefined;
    return result?.status === "failed"
      ? "Branch-worktree publication recorded a recovery-required partial-failure receipt and was not retried."
      : "The separately approved reviewed change set was applied only in a new deterministic branch worktree. The original checkout was unchanged, and no commit, push, GitHub, provider, deployment, or release operation ran.";
  }
  if (
    message.includes("publish reviewed change set locally") ||
    message.includes("retry local publication") ||
    message.includes("publish reviewed change set with stale")
  ) {
    const stale = message.includes("stale");
    const retry = message.includes("retry");
    const afterCancellation = message.includes("after cancellation");
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    const workflow = status?.output as
      { phase?: string; review?: { digest?: string } } | undefined;
    const latestPublicationIndex = toolResults.findLastIndex(
      ({ name }) => name === "publish_reviewed_change_set",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "workspace_status",
    );
    if (
      status === undefined ||
      (retry && latestPublicationIndex > latestStatusIndex) ||
      workflow === undefined ||
      ![
        "reviewed",
        "publication_pending",
        "publication_failed",
        "published_local",
      ].includes(workflow?.phase ?? "")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const source = [...toolResults]
      .reverse()
      .find(({ name }) => name === "inspect_source");
    const destinationPath = (
      source?.output as { sourcePath?: string } | undefined
    )?.sourcePath;
    if (destinationPath === undefined || workflow.review?.digest === undefined)
      return "An exact reviewed receipt and explicitly inspected local checkout are required before local publication.";
    const reviewDigest = workflow.review.digest;
    const publicationResults = toolResults.filter(
      ({ name }) => name === "publish_reviewed_change_set",
    );
    const required = stale ? 4 : retry ? 3 : afterCancellation ? 2 : 1;
    const publicationStatuses = toolResults.filter(
      ({ name }) => name === "local_publication_status",
    );
    const latestPublicationStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "local_publication_status",
    );
    if (
      latestPublicationStatusIndex < latestStatusIndex ||
      latestPublicationStatusIndex < latestPublicationIndex
    )
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    if (
      message.includes("dirty overlap") &&
      toolResults.at(-1)?.name !== "local_publication_status"
    )
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    const proposal = [...publicationStatuses].reverse().at(0);
    if (proposal === undefined)
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    if (proposal.isError || proposal.output === undefined) {
      if (message.includes("dirty overlap"))
        return "Local publication preconditions were rejected before approval or destination mutation.";
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    }
    const publicationState = proposal.output as {
      status?: string;
      retryAllowed?: boolean;
      recoveryAllowed?: boolean;
      transactionWindow?: string;
      workflowPhase?: string;
    };
    const durableStatus = publicationState.status;
    const latestPublicationOutput = publicationResults.at(-1)?.output as
      { reused?: boolean; terminalizedFailure?: boolean } | undefined;
    if (
      publicationState.workflowPhase === "published_local" &&
      retry &&
      latestPublicationOutput?.reused === true
    )
      return "The lost-response retry reused the exact durable local-publication receipt after postimage readback.";
    if (
      publicationState.workflowPhase === "published_local" &&
      !retry &&
      !stale
    )
      return "The separately approved reviewed change set was applied only to the named existing local checkout. No commit, branch, GitHub publication, provider, deployment, or release action ran.";
    if (
      publicationState.workflowPhase === "publication_failed" &&
      latestPublicationOutput?.terminalizedFailure === true
    )
      return "The exact durable local-publication failure was terminalized without redispatching destination mutation.";
    if (publicationState.workflowPhase === "publication_failed")
      return "The failed local-publication receipt is readable and was not redispatched automatically.";
    if (publicationState.recoveryAllowed === true && !retry)
      return "The durable terminal local-publication journal awaits an explicit recovery request and was not redispatched automatically.";
    if (
      durableStatus === "pending" ||
      publicationState.transactionWindow === "before-journal" ||
      (durableStatus === "failed" && !publicationState.recoveryAllowed)
    )
      return "The prior local-publication attempt is recovery-required and was not redispatched automatically.";
    const publicationProposal = {
      ...(proposal.output as Record<string, unknown>),
    };
    if (typeof publicationProposal.proposalDigest === "string")
      publicationProposal.digest = publicationProposal.proposalDigest;
    delete publicationProposal.workflowPhase;
    delete publicationProposal.recoveryAllowed;
    delete publicationProposal.retryAllowed;
    delete publicationProposal.transactionWindow;
    delete publicationProposal.durableJournal;
    delete publicationProposal.status;
    delete publicationProposal.publishedByCallId;
    delete publicationProposal.beforeStatusDigest;
    delete publicationProposal.afterStatusDigest;
    delete publicationProposal.appliedPaths;
    delete publicationProposal.intentPaths;
    delete publicationProposal.rolledBackPaths;
    delete publicationProposal.conflictedPaths;
    delete publicationProposal.uncertainPaths;
    delete publicationProposal.pathEvidence;
    delete publicationProposal.recoveryRequired;
    delete publicationProposal.reason;
    delete publicationProposal.failureMessage;
    delete publicationProposal.proposalDigest;
    delete publicationProposal.postconditionDigest;
    const recoveryResult = toolResults
      .slice(latestPublicationStatusIndex + 1)
      .find(({ name }) => name === "publish_reviewed_change_set");
    if (
      publicationState.recoveryAllowed === true &&
      recoveryResult === undefined
    )
      return {
        toolCalls: [
          {
            name: "publish_reviewed_change_set",
            input: { publication: publicationProposal },
          },
        ],
      };
    if (
      publicationState.recoveryAllowed !== true &&
      publicationResults.length < required
    )
      return {
        toolCalls: [
          {
            name: "publish_reviewed_change_set",
            input: {
              publication: stale
                ? {
                    ...publicationProposal,
                    reviewDigest: "0".repeat(64),
                  }
                : publicationProposal,
            },
          },
        ],
      };
    const result = recoveryResult ?? publicationResults.at(-1);
    if (result?.isError)
      return stale
        ? "Stale local publication was rejected without changing the destination checkout."
        : "Local publication was canceled or rejected; the reviewed receipt was preserved.";
    const output = result?.output as
      { reused?: boolean; terminalizedFailure?: boolean } | undefined;
    return output?.terminalizedFailure === true
      ? "The exact durable local-publication failure was terminalized without redispatching destination mutation."
      : output?.reused === true
        ? "The lost-response retry reused the exact durable local-publication receipt after postimage readback."
        : "The separately approved reviewed change set was applied only to the named existing local checkout. No commit, branch, GitHub publication, provider, deployment, or release action ran.";
  }
  if (message.includes("read recorded prototype artifact")) {
    const stale = message.includes("stale digest");
    const recorded = [...toolResults]
      .reverse()
      .find(
        ({ name, isError }) => name === "record_prototype_artifact" && !isError,
      );
    if (recorded === undefined && !stale)
      return "Record a prototype artifact before reading it.";
    const artifact = recorded?.output as
      { path?: string; digest?: string } | undefined;
    const read = [...toolResults]
      .reverse()
      .find(({ name }) => name === "get_prototype_artifact");
    if (read !== undefined && !(stale && !read.isError)) {
      if (read.isError)
        return "The prototype artifact digest was rejected as stale.";
      const output = read.output as
        { path?: string; digest?: string; content?: string } | undefined;
      return output?.path === artifact?.path &&
        output?.digest === artifact?.digest &&
        typeof output?.content === "string"
        ? "The exact content-addressed prototype artifact was read without a target command."
        : "The prototype artifact readback did not match its recorded receipt.";
    }
    return {
      toolCalls: [
        {
          name: "get_prototype_artifact",
          input: {
            path: stale
              ? "prototype/expense-review/app-spec.md"
              : artifact?.path,
            digest: stale ? "0".repeat(64) : artifact?.digest,
          },
        },
      ],
    };
  }
  if (message.includes("assess workspace readiness before planning")) {
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      status === undefined ||
      (status.output as { phase?: string }).phase === "empty"
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const readiness = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_readiness_status");
    if (readiness === undefined)
      return { toolCalls: [{ name: "workspace_readiness_status", input: {} }] };
    return "The workspace readiness receipt is not ready for target execution, and no target command was run.";
  }
  if (message.includes("assess target command readiness")) {
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (statusResult === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { phase?: string; proposal?: { digest?: string } } | undefined;
    if (
      status?.phase !== "planned" &&
      status?.phase !== "apply_failed" &&
      status?.phase !== "applied" &&
      status?.phase !== "validation_pending" &&
      status?.phase !== "validation_failed" &&
      status?.phase !== "validated"
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const readinessResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "target_execution_status");
    const staleRequest = message.includes("stale proposal digest");
    if (
      readinessResult === undefined ||
      (staleRequest && !readinessResult.isError)
    ) {
      const digest = staleRequest ? "0".repeat(64) : status?.proposal?.digest;
      if (digest === undefined)
        return "A canonical proposal is required before target command readiness can be checked.";
      return {
        toolCalls: [
          {
            name: "target_execution_status",
            input: { expectedProposalDigest: digest },
          },
        ],
      };
    }
    if (readinessResult.isError)
      return "The target command readiness receipt rejected the stale proposal.";
    const readiness = readinessResult.output as
      { targetCommandReady?: boolean } | undefined;
    return readiness?.targetCommandReady === true
      ? "The exact proposal is ready for a future typed target command."
      : "The exact proposal is not ready for a target command, and no target command was run.";
  }
  if (message.includes("inspect the sandbox toolchain")) {
    const result = toolResults.find(
      ({ name }) => name === "inspect_sandbox_toolchain",
    );
    if (result === undefined)
      return {
        toolCalls: [{ name: "inspect_sandbox_toolchain", input: {} }],
      };
    return result.isError
      ? "Sandbox toolchain inspection failed."
      : `Sandbox toolchain receipt: ${JSON.stringify(result.output)}`;
  }
  if (message.includes("attempt appspec mutation after publication")) {
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (status === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const workflow = status.output as
      | {
          phase?: string;
          workspace?: {
            sourceSha?: string;
            sourceTree?: string;
            eligibilityDigest?: string;
            workspaceDigest?: string;
          };
          appSpec?: {
            appId?: string;
            digest?: string;
            artifactRevision?: string;
          };
        }
      | undefined;
    const attempts = toolResults.filter(
      ({ name }) => name === "accept_app_spec",
    );
    if (attempts.length < 2)
      return {
        toolCalls: [
          {
            name: "accept_app_spec",
            input: {
              appId: workflow?.appSpec?.appId,
              expectedArtifactDigest: workflow?.appSpec?.digest,
              expectedArtifactRevision: workflow?.appSpec?.artifactRevision,
              expectedSourceSha: workflow?.workspace?.sourceSha,
              expectedSourceTree: workflow?.workspace?.sourceTree,
              expectedEligibilityDigest: workflow?.workspace?.eligibilityDigest,
              expectedWorkspaceDigest: workflow?.workspace?.workspaceDigest,
            },
          },
        ],
      };
    return attempts.at(-1)?.isError
      ? "AppSpec mutation was denied by the terminal publication workflow."
      : "AppSpec mutation unexpectedly succeeded.";
  }
  const appSpecMatch =
    /^accept build-ready appspec for ([a-z0-9-]+):\n([\s\S]+)$/iu.exec(
      lastUserMessage ?? "",
    );
  if (appSpecMatch !== null) {
    const [, appId, appSpec] = appSpecMatch;
    if (appId === undefined || appSpec === undefined)
      return "The AppSpec request is malformed.";
    const statusResult = toolResults.find(
      ({ name }) => name === "workspace_status",
    );
    if (statusResult === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      | {
          workspace?: {
            sourceSha?: string;
            sourceTree?: string;
            eligibilityDigest?: string;
            workspaceDigest?: string;
          };
        }
      | undefined;
    const workspace = status?.workspace;
    const acceptanceResult = toolResults.find(
      ({ name }) => name === "accept_app_spec",
    );
    if (acceptanceResult === undefined) {
      const artifactResult = [...toolResults]
        .reverse()
        .find(({ name }) => name === "record_prototype_artifact");
      if (artifactResult === undefined)
        return {
          toolCalls: [
            {
              name: "record_prototype_artifact",
              input: {
                path: `prototype/${appId}/app-spec.md`,
                mediaType: "text/markdown",
                content: appSpec,
              },
            },
          ],
        };
      const artifact = artifactResult.output as
        { digest?: string; revision?: string } | undefined;
      if (
        workspace?.sourceSha === undefined ||
        workspace.sourceTree === undefined ||
        workspace.eligibilityDigest === undefined ||
        workspace.workspaceDigest === undefined ||
        artifact?.digest === undefined ||
        artifact.revision === undefined
      )
        return "A verified prepared workspace is required before AppSpec acceptance.";
      return {
        toolCalls: [
          {
            name: "accept_app_spec",
            input: {
              appId,
              expectedArtifactDigest: artifact.digest,
              expectedArtifactRevision: artifact.revision,
              expectedSourceSha: workspace.sourceSha,
              expectedSourceTree: workspace.sourceTree,
              expectedEligibilityDigest: workspace.eligibilityDigest,
              expectedWorkspaceDigest: workspace.workspaceDigest,
            },
          },
        ],
      };
    }
    if (acceptanceResult.isError)
      return "The AppSpec acceptance could not be recorded.";
    return "The build-ready AppSpec was accepted. Target identity and planning require a separate explicit request and approval.";
  }
  if (
    message.includes("prepare supported repository at ") ||
    message.includes("prepare fresh template at ")
  ) {
    const path = lastUserMessage?.match(
      /prepare (?:supported repository|fresh template) at (\/\S+)/iu,
    )?.[1];
    if (path === undefined) return "The configured test repository is missing.";
    const sourceKind = message.includes("prepare fresh template at ")
      ? "fresh-template"
      : "existing-repository";
    const inspectionResult = toolResults.find(
      ({ name }) => name === "inspect_source",
    );
    if (inspectionResult === undefined) {
      return {
        toolCalls: [{ name: "inspect_source", input: { path, sourceKind } }],
      };
    }
    const inspected = inspectionResult.output as
      | {
          digest?: string;
        }
      | undefined;
    if (inspectionResult.isError) {
      return "The configured repository could not be inspected.";
    }
    const acquisitionResult = toolResults.find(
      ({ name }) => name === "approve_source_acquisition",
    );
    if (sourceKind === "fresh-template" && acquisitionResult === undefined) {
      if (inspected?.digest === undefined)
        return "The configured source receipt is incomplete.";
      return {
        toolCalls: [
          {
            name: "approve_source_acquisition",
            input: { expectedSourceReceiptDigest: inspected.digest },
          },
        ],
      };
    }
    if (acquisitionResult?.isError) {
      const sourceStatus = toolResults.find(
        ({ name }) => name === "source_status",
      );
      if (sourceStatus === undefined)
        return { toolCalls: [{ name: "source_status", input: {} }] };
      return "Fresh-template acquisition was canceled or became stale; no workspace was materialized.";
    }
    const preparationResult = toolResults.find(
      ({ name }) => name === "prepare_workspace",
    );
    if (preparationResult === undefined) {
      if (inspected?.digest === undefined) {
        return "The configured repository is not eligible.";
      }
      return {
        toolCalls: [
          {
            name: "prepare_workspace",
            input: {
              expectedSourceReceiptDigest: inspected.digest,
            },
          },
        ],
      };
    }
    const statusResult = toolResults.find(
      ({ name }) => name === "workspace_status",
    );
    if (statusResult === undefined) {
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    }
    if (statusResult.isError) {
      return "The workspace status could not be verified.";
    }
    const status = statusResult.output as { phase?: string } | undefined;
    if (preparationResult.isError) {
      return status?.phase === "empty"
        ? "Preparation was canceled, and the workspace phase remains empty."
        : "Preparation was canceled, but the workspace phase could not be confirmed empty.";
    }
    return status?.phase === "prepared"
      ? "The reviewed repository was prepared inside the App Builder workspace, and workspace status confirms the prepared phase."
      : "The repository preparation completed, but workspace status did not confirm the prepared phase.";
  }
  if (message.includes("capabilities")) {
    const localPublication =
      process.env.APP_BUILDER_LOCAL_PUBLICATION === "1"
        ? " After one further approval, I can apply that exact reviewed set only to a named existing local checkout with base, preimage, status, and postimage verification; it never commits, changes history, or publishes remotely."
        : " Local checkout publication is disabled on this host; I can still produce and review the exact change set without mutating the checkout.";
    const branchPublication =
      process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION === "1"
        ? " As a distinct outcome with another approval, I can create a deterministic uncommitted branch/worktree at the exact reviewed base, apply only the reviewed paths there, preserve the original checkout, and require a separate digest-bound approval for partial-failure or lost-response recovery."
        : " Branch/worktree publication is disabled on this host.";
    const freshBootstrap =
      process.env.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED === "1" &&
      process.env.APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT !== undefined &&
      process.env.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT !== undefined
        ? " With another approval, fresh local bootstrap is enabled for an exact absent or exact-empty destination under the configured owner-only root; it creates one release-disabled parentless commit and never configures a remote."
        : " Fresh local bootstrap publication is disabled on this host.";
    return `I can inspect an explicitly allowlisted existing repository or fresh-template local checkout and, after the required approvals, prepare its exact reviewed tree read-only inside an isolated App Builder workspace. Fresh templates require a separate acquisition approval before independently approved materialization. Generated state remains release-disabled. I can record and exactly read session-bound prototype artifact receipts, accept a recorded AppSpec revision, verify offline dependencies, run fixed target identity and planning, separately apply the exact proposal only in a fresh builder-owned overlay, and after another approval run the fixed check and test commands in independent validation overlays, then show and separately accept an exact normalized reviewed change set.${localPublication}${branchPublication}${freshBootstrap} A typed least-privilege GitHub acquisition/private-repository/draft-PR contract is defined, but live GitHub calls remain disabled until an installation-bound adapter and durable receipt store are configured. Generic shell access is never a GitHub fallback.`;
  }
  return "I am the Autograph App Builder. Tell me whether you are starting from the supported template or iterating on an existing supported repository, and describe the app outcome you want.";
});

export default defineAgent({
  model: hasTestCapability("mock-model") ? testModel : "openai/gpt-5.6-terra",
  modelContextWindowTokens: 128_000,
  reasoning: "high",
  limits: {
    maxInputTokensPerSession: 2_000_000,
    maxOutputTokensPerSession: 200_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
