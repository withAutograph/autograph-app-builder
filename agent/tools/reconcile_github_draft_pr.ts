import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  approvalReceiptSchema,
  approvalTargetFromExistingDraftReconciliation,
  assertApprovalReceipt,
} from "@/lib/agent/approval-receipt";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";

export default defineTool({
  approval: always(),
  description:
    "After separate exact proposal approval, update the same open draft PR with the reviewed merge commit. Reject a moved base/head, changed resolved bytes, repository mismatch, or a PR that is no longer an open draft. This never force pushes or deploys.",
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    // oxlint-disable-next-line sonarjs/expression-complexity -- publication requires all sealed candidate preconditions.
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- one exact candidate precondition.
      candidate === null ||
      candidate.proposal === undefined ||
      candidate.review === undefined ||
      candidate.validation === undefined ||
      state.phase !== "reviewed" ||
      state.githubSource?.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "The approved draft reconciliation is unavailable or no longer matches the selected app. Review and seal its current merge before requesting approval.",
      );
    }
    const { proposal, review } = candidate;
    if (
      input.expectedProposalDigest !== proposal.digest ||
      proposal.repositoryId !== state.githubSource.repository.repositoryId ||
      proposal.reviewDigest !== review.digest
    ) {
      throw new Error(
        "The repository or sealed draft reconciliation changed. Review both current diffs and request approval for a new proposal.",
      );
    }
    assertApprovalReceipt({
      actual: input.approvalReceipt,
      phase: "draft_update",
      subjectDigest: proposal.digest,
      target: approvalTargetFromExistingDraftReconciliation(proposal),
    });
    const sandbox = await ctx.getSandbox();
    const observed = await inspectDraftReconciliation({ prepared: candidate, sandbox });
    if (
      observed.unresolvedConflicts.length > 0 ||
      observed.resolvedTree !== proposal.resolvedTree ||
      observed.resolvedTree !== candidate.validation.resolvedTree
    ) {
      throw new Error(
        "The reconciled checkout changed after validation and approval. Rerun checks, review both diffs, and request approval for the new result.",
      );
    }
    const changes = new Map(review.baseChanges.map((change) => [change.path, change]));
    const relativeRoot = candidate.root.slice(candidate.workspaceRoot.length + 1);
    const contentSource = {
      async readFile(path: string) {
        const expected = changes.get(path);
        if (expected?.after === undefined) {
          return null;
        }
        const bytes = await sandbox.readBinaryFile({ path: `${relativeRoot}/${path}` });
        if (
          bytes === null ||
          createHash("sha256").update(bytes).digest("hex") !== expected.after.digest
        ) {
          throw new Error(
            `The resolved file ${path} changed after review. Rerun validation and review both diffs before updating the draft.`,
          );
        }
        return { bytes, digest: expected.after.digest, mode: expected.after.mode };
      },
      // oxlint-disable-next-line eslint/require-await -- preserve async content-source interface.
      async readFreshTree() {
        throw new Error("A fresh repository tree is unavailable for draft reconciliation.");
      },
    };
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return await runtime.reconcileExistingDraft({ contentSource, proposal, review });
  },
  inputSchema: z.strictObject({
    approvalReceipt: approvalReceiptSchema,
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
