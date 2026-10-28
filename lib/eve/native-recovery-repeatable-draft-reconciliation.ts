/* oxlint-disable typescript/no-unsafe-type-assertion -- Private SDK values cross the owning source/review validators below; no cast itself grants retry eligibility. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { approvalReceiptForExistingDraftUpdate } from "../agent/approval-receipt";
import type {
  DraftReconciliationCandidate,
  DraftReconciliationCompletion,
} from "../agent/draft-reconciliation-state";
import { assertExactImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { currentDraftCandidateSource } from "../agent/published-draft-repair";
import type { AppBuilderWorkflowState } from "../agent/workflow-state";
import { createReconciliationReviewReceipt } from "../repository/github-draft-reconciliation";
import type {
  ExistingDraftReconciliationProposal,
  ReconciliationReviewReceipt,
} from "../repository/github-draft-reconciliation";

const workflowKey = "autograph-app-builder.workflow.v17";
const candidateKey = "autograph-app-builder.draft-reconciliation.v1";
const completionsKey = "autograph-app-builder.draft-reconciliation-completions.v1";
const part = z.looseObject({
  type: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  providerExecuted: z.boolean().optional(),
  approvalId: z.string().optional(),
  approved: z.boolean().optional(),
});
const event = z.looseObject({ type: z.string(), data: z.looseObject({}) });
const payloadSchema = z.object({
  binding: z.object({ ownerRunId: z.string(), logicalSessionId: z.string() }),
  nativeEvents: z.array(event),
  candidates: z.array(
    z.object({
      origin: z.object({ slot: z.number().int().nonnegative() }),
      serializedContext: z.looseObject({ "eve.sessionId": z.string() }),
      sessionState: z.object({
        snapshot: z.object({
          session: z.object({
            sessionId: z.string(),
            history: z.array(
              z.object({ role: z.string(), content: z.union([z.string(), z.array(part)]) }),
            ),
          }),
        }),
      }),
      incoming: z
        .object({
          runtimeResults: z
            .object({ results: z.array(z.object({ callId: z.string() })) })
            .optional(),
        })
        .optional(),
    }),
  ),
});
const requestSchema = z.object({
  kind: z.literal("tool-approval"),
  requestId: z.string().min(1),
  action: z.object({ callId: z.string(), toolName: z.string(), input: z.unknown() }),
});
const settlementSchema = z.object({
  requestId: z.string(),
  outcome: z.enum(["approved", "cancelled"]),
  responderPrincipalId: z.string(),
});
const proposalInputSchema = z.strictObject({
  expectedProposalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  approvalReceipt: z.unknown(),
  recordCurrentEquivalentRelease: z.literal(true),
});
interface DraftReconciliationRecoveryInput {
  descriptor: { logicalSessionId: string; originalAuthoritySessionId: string };
  binding: { ownerRunId: string; logicalSessionId: string };
  expectedPrincipalId: string;
  payload: unknown;
}
type Part = z.infer<typeof part>;
type Event = z.infer<typeof event>;

const uniqueHistoryApproval = (parts: Part[], callId: string): boolean => {
  const requests = parts.filter(
    (value) => value.type === "tool-approval-request" && value.toolCallId === callId,
  );
  if (
    requests.length !== 1 ||
    requests[0].approvalId === undefined ||
    requests[0].approvalId.length === 0
  ) {
    return false;
  }
  const approvalId = requests[0].approvalId;
  const responses = parts.filter(
    (value) => value.type === "tool-approval-response" && value.approvalId === approvalId,
  );
  return (
    parts.filter(
      (value) => value.type === "tool-approval-request" && value.approvalId === approvalId,
    ).length === 1 &&
    responses.length === 1 &&
    responses[0].approved === true
  );
};

/** Native server frames, not a model/history approval response, establish the human decision. */
const nativeHumanApproval = (events: Event[], call: Part, expectedPrincipalId: string): boolean => {
  const requests = events.flatMap((value, index) => {
    if (value.type !== "input.requested") {
      return [];
    }
    const parsed = z.object({ requests: z.array(z.unknown()) }).safeParse(value.data).data;
    return (parsed?.requests ?? []).flatMap((entry) => {
      const action = z.object({ action: z.object({ callId: z.string() }) }).safeParse(entry)
        .data?.action;
      if (action?.callId !== call.toolCallId) {
        return [];
      }
      const request = requestSchema.safeParse(entry).data;
      return [{ request, index }];
    });
  });
  if (requests.length !== 1 || requests[0].request === undefined) {
    return false;
  }
  const { request, index } = requests[0];
  const requestIdMatches = events.flatMap((value) => {
    if (value.type !== "input.requested") {
      return [];
    }
    const parsed = z.object({ requests: z.array(z.unknown()) }).safeParse(value.data).data;
    return (parsed?.requests ?? []).filter(
      (entry) =>
        z.object({ requestId: z.string() }).safeParse(entry).data?.requestId === request.requestId,
    );
  });
  if (
    requestIdMatches.length !== 1 ||
    request.action.toolName !== call.toolName ||
    !isDeepStrictEqual(request.action.input, call.input)
  ) {
    return false;
  }
  const settlements = events.flatMap((value, settledIndex) => {
    if (value.type !== "approval.settled") {
      return [];
    }
    if (
      z.object({ requestId: z.string() }).safeParse(value.data).data?.requestId !==
      request.requestId
    ) {
      return [];
    }
    const settlement = settlementSchema.safeParse(value.data).data;
    return [{ settlement, settledIndex }];
  });
  if (settlements.length !== 1 || settlements[0].settlement === undefined) {
    return false;
  }
  return (
    settlements[0].settledIndex > index &&
    settlements[0].settlement.outcome === "approved" &&
    settlements[0].settlement.responderPrincipalId === expectedPrincipalId
  );
};

type ProposalDigestMaterial =
  | Omit<ExistingDraftReconciliationProposal, "digest">
  | Omit<ExistingDraftReconciliationProposal, "digest" | "idempotencyKey">
  | ReconciliationReviewReceipt["baseChanges"];
const hash = (value: ProposalDigestMaterial) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The current tool still performs fresh owner, artifact, installation, source and provider checks.
// This policy only identifies its same sealed proposal in Git read-only mode; it infers no write outcome.
const currentCompletion = (
  context: z.infer<typeof payloadSchema>["candidates"][number]["serializedContext"],
  digest: string,
  input: DraftReconciliationRecoveryInput,
): DraftReconciliationCompletion | undefined => {
  try {
    const values = z.array(z.unknown()).parse(context[completionsKey]);
    const matches = values.filter(
      (value) =>
        z.object({ proposal: z.object({ digest: z.string() }) }).safeParse(value).data?.proposal
          .digest === digest,
    );
    if (matches.length !== 1) {
      return undefined;
    }
    // SAFETY: Owning source/review validators and current-candidate checks below reject malformed private metadata before eligibility.
    const completion = matches[0] as DraftReconciliationCompletion;
    // SAFETY: currentDraftCandidateSource checks this private candidate's source and scope; failures return no eligible calls.
    const candidate = context[candidateKey] as DraftReconciliationCandidate;
    // SAFETY: The owning current-source predicate validates state identity and phase before metadata permits a retry.
    const state = context[workflowKey] as AppBuilderWorkflowState;
    if (
      completion.preparation !== "sealed-before-approval" ||
      candidate?.kind === "published-draft-repair" ||
      candidate?.validation === undefined ||
      state.phase !== "reviewed"
    ) {
      return undefined;
    }
    const source = currentDraftCandidateSource(state, candidate);
    if (source === undefined) {
      return undefined;
    }
    assertExactImmutableGitHubSourceReceipt(source);
    const { proposal, review, compilation } = completion;
    const { digest: claimed, ...unsigned } = proposal;
    const { idempotencyKey, ...identity } = unsigned;
    const { digest: reviewDigest, approvedPaths, ...reviewInput } = review;
    const canonicalReview = createReconciliationReviewReceipt(reviewInput);
    const matchesCurrent = [
      proposal.version === 1,
      proposal.intendedOutcome === "reconcile-existing-draft-pull-request",
      claimed === digest,
      claimed === hash(unsigned),
      idempotencyKey === hash(identity),
      isDeepStrictEqual(review, canonicalReview),
      reviewDigest === canonicalReview.digest,
      isDeepStrictEqual(approvedPaths, canonicalReview.approvedPaths),
      isDeepStrictEqual(candidate.proposal, proposal),
      isDeepStrictEqual(candidate.review, review),
      isDeepStrictEqual(candidate.publishedOrigin, completion.publishedOrigin),
      isDeepStrictEqual(candidate.publicationScope, completion.publicationScope),
      isDeepStrictEqual(review.publicationScope, completion.publicationScope),
      isDeepStrictEqual(candidate.validation.compilation, compilation),
      candidate.validation.commands.every(({ exitCode }) => exitCode === 0),
      candidate.validation.resolvedTree === proposal.resolvedTree,
      completion.appId === candidate.appId,
      completion.appId === review.appId,
      completion.root === candidate.root,
      completion.githubSourceDigest === candidate.githubSourceDigest,
      source.digest === completion.githubSourceDigest,
      state.appSpec.appId === completion.appId,
      state.appSpec.digest === completion.appReview.appSpecDigest,
      state.reviewReceipt.digest === completion.appReview.digest,
      state.reviewReceipt.appSpecDigest === completion.appReview.appSpecDigest,
      state.reviewReceipt.changeSetDigest === completion.appReview.changeSetDigest,
      "ownerUserId" in compilation.context.authority &&
        compilation.context.authority.ownerUserId === input.expectedPrincipalId,
      compilation.context.target.sessionId === input.descriptor.originalAuthoritySessionId,
      compilation.context.target.appId === completion.appId,
      source.resolvedRef === `refs/heads/${proposal.branchName}`,
      source.repository.repositoryId === proposal.repositoryId,
      source.repository.owner === proposal.owner,
      source.repository.name === proposal.name,
      // Source-read and publication identities hash different operation/permission scopes.
      // The tool freshly checks publication installation identity against this exact approved proposal.
      candidate.repositoryId === proposal.repositoryId,
      candidate.pullRequestNumber === proposal.pullRequestNumber,
      candidate.headSha === proposal.expectedHeadSha,
      candidate.headTree === proposal.expectedHeadTree,
      candidate.baseSha === proposal.expectedBaseSha,
      candidate.baseTree === proposal.expectedBaseTree,
      review.headSha === proposal.expectedHeadSha,
      review.headTree === proposal.expectedHeadTree,
      review.baseSha === proposal.expectedBaseSha,
      review.baseTree === proposal.expectedBaseTree,
      review.resolvedTree === proposal.resolvedTree,
      proposal.reviewDigest === review.digest,
      proposal.baseChangesDigest === hash(review.baseChanges),
      proposal.headChangesDigest === hash(review.headChanges),
      isDeepStrictEqual(proposal.approvedPaths, review.approvedPaths),
    ].every(Boolean);
    return matchesCurrent ? completion : undefined;
  } catch {
    return undefined;
  }
};

/** Exact verified-publication/source-association recovery only; native effects still veto replay. */
export const authorizeRepeatableDraftReconciliationCalls = (
  input: DraftReconciliationRecoveryInput,
): readonly string[] => {
  const payload = payloadSchema.safeParse(input.payload).data;
  if (
    payload === undefined ||
    input.expectedPrincipalId.length === 0 ||
    !isDeepStrictEqual(payload.binding, input.binding) ||
    input.binding.logicalSessionId !== input.descriptor.logicalSessionId
  ) {
    return [];
  }
  const latest = payload.candidates.toSorted((a, b) => b.origin.slot - a.origin.slot)[0];
  if (
    latest === undefined ||
    payload.candidates.filter((value) => value.origin.slot === latest.origin.slot).length !== 1 ||
    latest.serializedContext["eve.sessionId"] !== input.descriptor.logicalSessionId ||
    latest.sessionState.snapshot.session.sessionId !== input.descriptor.logicalSessionId
  ) {
    return [];
  }
  const parts = latest.sessionState.snapshot.session.history.flatMap((value) =>
    Array.isArray(value.content) ? value.content : [],
  );
  return parts.flatMap((call) => {
    const callId = call.toolCallId;
    if (callId === undefined || callId.length === 0) {
      return [];
    }
    if (
      call.type !== "tool-call" ||
      call.toolName !== "reconcile_github_draft_pr" ||
      call.providerExecuted === true
    ) {
      return [];
    }
    if (
      parts.filter((value) => value.type === "tool-call" && value.toolCallId === callId).length !==
        1 ||
      parts.some((value) => value.type === "tool-result" && value.toolCallId === callId) ||
      !uniqueHistoryApproval(parts, callId) ||
      !nativeHumanApproval(payload.nativeEvents, call, input.expectedPrincipalId)
    ) {
      return [];
    }
    if (
      payload.nativeEvents.some(
        (value) =>
          value.type === "action.result" &&
          z.object({ result: z.object({ callId: z.string() }) }).safeParse(value.data).data?.result
            .callId === callId,
      ) ||
      payload.candidates.some(
        (value) =>
          value.incoming?.runtimeResults?.results.some((result) => result.callId === callId) ===
          true,
      )
    ) {
      return [];
    }
    const parsed = proposalInputSchema.safeParse(call.input).data;
    if (parsed === undefined) {
      return [];
    }
    const completion = currentCompletion(
      latest.serializedContext,
      parsed.expectedProposalDigest,
      input,
    );
    if (
      completion === undefined ||
      !isDeepStrictEqual(
        parsed.approvalReceipt,
        approvalReceiptForExistingDraftUpdate(completion.proposal),
      )
    ) {
      return [];
    }
    return [callId];
  });
};
