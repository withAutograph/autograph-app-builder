import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import type { ApprovalReceipt } from "./approval-receipt";
import {
  approvalReceiptForExistingDraftUpdate,
  approvalTargetFromExistingDraftUpdate,
  assertApprovalReceipt,
} from "./approval-receipt";
import { appBuilderWorkflowState } from "./workflow-state";
import {
  draftCandidateValidationDigest,
  currentDraftCandidateSource,
} from "./published-draft-repair";
import {
  draftReconciliationState,
  publishedDraftRepairCompletions,
  retainPublishedDraftRepairCompletion,
} from "./draft-reconciliation-state";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { getSourceBoundSandbox } from "./source-bound-sandbox";
import { inspectDraftReconciliation } from "../repository/sandbox-draft-reconciliation";
import { assertPublishedDraftRepairReview } from "../repository/published-draft-repair-review";
import { assertReconciliationCompletionOwnerForSession } from "./compiled-operator-artifacts";
import { recordPublishedDraftRepairForSession } from "./published-app-source";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";

const retainAndReturn = (
  completion: Parameters<typeof retainPublishedDraftRepairCompletion>[0],
) => {
  retainPublishedDraftRepairCompletion(completion);
  return completion;
};
const completionSession = (ctx: ToolContext) => ({
  sessionAuth: ctx.session.auth,
  adapterSessionId: ctx.session.id,
  callbackExecution: hostedOperatorCallbackExecution(ctx.session),
});

export const sealPublishedDraftRepair = async (input: {
  ctx: ToolContext;
  expectedReviewDigest: string;
  expectedGitHubSourceDigest?: string;
  pullRequestNumber?: number;
}) => {
  const { ctx } = input;
  const state = appBuilderWorkflowState.get();
  const candidate = draftReconciliationState.get();
  if (state.phase !== "reviewed" || candidate?.kind !== "published-draft-repair") {
    throw new Error("Prepare the current owned draft repair before sealing its update.");
  }
  if (
    currentDraftCandidateSource(state, candidate) === undefined ||
    candidate.repairReview?.digest !== input.expectedReviewDigest ||
    candidate.validation?.compilation === undefined
  ) {
    throw new Error(
      "Validate and review this current owned draft repair before sealing its update.",
    );
  }
  const { repair, repairReview: review, validation } = candidate;
  const compilation = candidate.validation.compilation;
  assertPublishedDraftRepairReview(review);
  const matches = [
    input.expectedGitHubSourceDigest === undefined ||
      input.expectedGitHubSourceDigest === repair.source.digest,
    input.pullRequestNumber === undefined ||
      input.pullRequestNumber === candidate.pullRequestNumber,
    review.repairSourceDigest === repair.source.digest,
    review.originReviewDigest === candidate.originalReviewDigest,
    review.validationDigest === draftCandidateValidationDigest(validation),
  ].every(Boolean);
  if (!matches) {
    throw new Error("The requested draft repair source, review or validation changed.");
  }
  const observed = await inspectDraftReconciliation({
    prepared: candidate,
    sandbox: await getSourceBoundSandbox(ctx),
  });
  if (
    observed.unresolvedConflicts.length > 0 ||
    observed.resolvedTree !== review.resolvedTree ||
    validation.resolvedTree !== review.resolvedTree
  ) {
    throw new Error("The draft repair changed after validation and review.");
  }
  const runtime = await githubPublicationRuntimeForSession(ctx.session.auth, {
    selectedInstallationId: repair.installationId,
  });
  const proposal = await runtime.sealExistingDraftUpdate({
    githubSource: repair.source,
    review,
    pullRequestNumber: candidate.pullRequestNumber,
    priorPublishedProposalDigest: repair.publicationProposalDigest,
    selectedCheckoutHeadSha: candidate.headSha,
    selectedCheckoutHeadTree: candidate.headTree,
  });
  const completion = {
    kind: "published-draft-repair" as const,
    proposal,
    review,
    appReview: {
      appSpecDigest: state.appSpec.digest,
      changeSetDigest: review.changeSetDigest,
      digest: review.digest,
    },
    appId: candidate.appId,
    root: candidate.root,
    repair,
    compilation,
  };
  await assertReconciliationCompletionOwnerForSession({
    ...completionSession(ctx),
    completion: retainAndReturn(completion),
  });
  return {
    ...proposal,
    approvalReceipt: approvalReceiptForExistingDraftUpdate(proposal),
    nextTool: "update_github_draft_pr" as const,
    baseline: "draft-head" as const,
  };
};

/** Exact applied-result observation precedes every checkout or private-byte requirement. */
export const updatePublishedDraftRepair = async (input: {
  ctx: ToolContext;
  expectedProposalDigest: string;
  approvalReceipt: ApprovalReceipt;
}) => {
  const { ctx } = input;
  const completion = publishedDraftRepairCompletions
    .get()
    .find((entry) => entry.proposal.digest === input.expectedProposalDigest);
  if (completion === undefined) {
    throw new Error("The exact sealed owned draft repair completion is unavailable.");
  }
  const { proposal, review, repair } = completion;
  assertApprovalReceipt({
    actual: input.approvalReceipt,
    phase: "draft_update",
    subjectDigest: proposal.digest,
    target: approvalTargetFromExistingDraftUpdate(proposal),
  });
  const session = { ...completionSession(ctx), completion };
  await assertReconciliationCompletionOwnerForSession(session);
  const runtime = await githubPublicationRuntimeForSession(ctx.session.auth, {
    selectedInstallationId: repair.installationId,
  });
  if (runtime.inspectAppliedExistingDraftUpdate === undefined) {
    throw new Error(
      "The runtime cannot read back the exact draft repair before opening private source.",
    );
  }
  const inspected = await runtime.inspectAppliedExistingDraftUpdate({ proposal, review });
  const finish = async (publication: typeof inspected.observation) => {
    try {
      const recording = await recordPublishedDraftRepairForSession({ ...session, publication });
      return { ...publication, appSourceRecording: { status: recording.status } };
    } catch {
      return {
        ...publication,
        appSourceRecording: {
          status: "unavailable" as const,
          recoveryRequired: true,
          nextAction:
            "Resume this same approved draft update to record its retained actual repair release. The GitHub update already succeeded; do not publish another PR or repeat Git writes.",
        },
      };
    }
  };
  if (inspected.applied) {
    return await finish(inspected.observation);
  }
  const state = appBuilderWorkflowState.get();
  const candidate = draftReconciliationState.get();
  if (
    candidate?.kind !== "published-draft-repair" ||
    state.phase !== "reviewed" ||
    candidate.validation === undefined
  ) {
    throw new Error("The approved private draft repair is no longer available.");
  }
  const current = [
    currentDraftCandidateSource(state, candidate) !== undefined,
    candidate.root === completion.root,
    candidate.repair.digest === repair.digest,
    candidate.repairReview?.digest === review.digest,
    candidate.validation.resolvedTree === review.resolvedTree,
    draftCandidateValidationDigest(candidate.validation) === review.validationDigest,
  ].every(Boolean);
  if (!current) {
    throw new Error(
      "The approved private draft repair is no longer the current validated candidate.",
    );
  }
  const sandbox = await getSourceBoundSandbox(ctx);
  const observed = await inspectDraftReconciliation({ prepared: candidate, sandbox });
  if (observed.unresolvedConflicts.length > 0 || observed.resolvedTree !== review.resolvedTree) {
    throw new Error("The owned draft repair changed after approval.");
  }
  const changes = new Map(review.changes.map((change) => [change.path, change]));
  const relativeRoot = candidate.root.slice(candidate.workspaceRoot.length + 1);
  const contentSource = {
    async readFile(path: string) {
      const change = changes.get(path);
      if (change?.after === undefined) {
        return null;
      }
      const bytes = await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` });
      if (
        bytes === null ||
        createHash("sha256").update(bytes).digest("hex") !== change.after.digest
      ) {
        throw new Error("The approved draft repair postimage changed.");
      }
      return { bytes, digest: change.after.digest, mode: change.after.mode };
    },
  };
  await assertReconciliationCompletionOwnerForSession(session);
  return await finish(await runtime.updateExistingDraft({ proposal, review, contentSource }));
};
