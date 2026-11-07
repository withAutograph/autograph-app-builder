import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resolveDraftReviewedWorkflow } from "../agent/draft-reviewed-lineage";
import type { DraftReviewedWorkflow } from "../agent/draft-reviewed-lineage";
import type { DraftReconciliationCandidate } from "../agent/draft-reconciliation-state";
import type { AppBuilderWorkflowState } from "../agent/workflow-state";
import { targetIdentitySchema, targetProposalSchema } from "../repository/target-planning";
import { executionDependencyLayoutSchema } from "../repository/dependency-cache";
import { targetApplyCommandReceiptSchema } from "../repository/target-apply";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "../repository/reviewed-change-set";

export const draftReviewedWorkflowContextKey = "autograph-app-builder.workflow.v17";
const workflowKey = draftReviewedWorkflowContextKey;
export const draftReviewedLineageContextKey = "autograph-app-builder.draft-reconciliation.v1";
const candidateKey = draftReviewedLineageContextKey;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const executionBinding = z.looseObject({
  appSpecDigest: digest,
  artifactRevision: text,
  dependencyCacheDigest: digest,
  eligibilityDigest: digest,
  imageDigest: digest,
  sourceReceiptDigest: digest,
  sourceSha: sha,
  sourceTree: sha,
  workspaceDigest: digest,
});
const overlayFile = z.looseObject({ digest, mode: text, path: text });
const applySchema = executionBinding.extend({
  appSpecPath: text,
  appliedByCallId: text,
  applyRoot: text,
  changedContentDigest: digest,
  changes: z.array(z.looseObject({ kind: z.enum(["added", "removed", "modified"]), path: text })),
  command: z.looseObject({
    exitCode: z.literal(0),
    name: z.enum(["create-app", "iterate-existing-app"]),
    stderrDigest: digest,
    stdoutDigest: digest,
  }),
  dependencyCacheContentDigest: digest,
  dependencyReceiptDigest: digest,
  digest,
  identityDigest: digest,
  planningTreeDigest: digest,
  postTree: z.array(overlayFile),
  postTreeDigest: digest,
  preTree: z.array(overlayFile),
  preTreeDigest: digest,
  preparedTreeDigest: digest,
  proposalDigest: digest,
  status: z.literal("applied"),
  targetReceipt: targetApplyCommandReceiptSchema,
  version: z.literal(2),
});
const originSchema = z.object({
  eventId: text,
  slot: z.number().int().nonnegative(),
  stepId: text,
});
const contextSchema = z.record(z.string(), z.unknown());
const checkpointSchema = z.object({
  origin: originSchema,
  serializedContext: contextSchema,
  sessionState: z.object({ snapshot: z.object({ session: z.object({ sessionId: text }) }) }),
});
const payloadSchema = z.object({
  binding: z.object({ logicalSessionId: text, ownerRunId: text }),
  candidates: z.array(checkpointSchema),
});
const candidateSchema = z.looseObject({
  appId: text,
  githubSourceDigest: digest,
  originalReviewDigest: digest,
  repositoryId: text,
  reviewedLineage: z.unknown().optional(),
  root: text,
  version: z.literal(1),
});
const workflowSchema = z.looseObject({
  appSpec: z.looseObject({
    acceptedByCallId: text,
    appId: text,
    artifactPath: text,
    artifactRevision: text,
    digest,
  }),
  applyReceipt: applySchema,
  githubSource: z
    .looseObject({ digest, repository: z.looseObject({ repositoryId: text }) })
    .optional(),
  identityReceipt: executionBinding.extend({
    digest,
    identity: targetIdentitySchema,
    resolvedByCallId: text,
    version: z.literal(1),
  }),
  phase: z.enum(["reviewed", "applied", "validation_pending", "validation_failed", "validated"]),
  proposal: executionBinding.extend({
    contractDigest: digest,
    digest,
    identityDigest: digest,
    plannedByCallId: text,
    target: targetProposalSchema,
    version: z.literal(1),
  }),
  sourceReceipt: z.looseObject({
    contractDigest: digest,
    digest,
    sourceKind: z.enum(["existing-repository", "fresh-template"]),
  }),
  workspace: z.looseObject({
    adapter: text,
    eligibilityDigest: digest,
    sourcePath: text,
    sourceSha: sha,
    sourceTree: sha,
    workspaceDigest: digest,
    workspaceId: text,
    workspacePath: text,
  }),
});
const reviewedSchema = workflowSchema.extend({
  artifacts: z.array(z.unknown()),
  dependencyReceipt: executionBinding.extend({
    cacheContentDigest: digest,
    cacheManifestDigest: digest,
    dependencyLayout: executionDependencyLayoutSchema,
    digest,
    preparedByCallId: text,
    targetSha: sha,
    targetTree: sha,
    version: z.literal(2),
  }),
  phase: z.literal("reviewed"),
  preparedByCallId: text,
  reviewReceipt: z.looseObject({
    approvedPaths: z.array(text),
    changeSetDigest: digest,
    changedContentDigest: digest,
    changes: z.array(z.looseObject({ path: text })),
    contractDigest: digest,
    digest,
    postTreeDigest: digest,
    preTreeDigest: digest,
    repositoryContractDigest: digest,
    reviewedByCallId: text,
    version: z.literal(2),
  }),
  validationReceipt: executionBinding.extend({
    appSpecPath: text,
    appValidationSha256: digest,
    appliedTreeDigest: digest,
    applyDigest: digest,
    attemptDigest: digest,
    changedContentDigest: digest,
    commands: z.array(
      z.looseObject({
        command: text,
        exitCode: z.literal(0),
        inputTreeDigest: digest,
        name: z.enum(["check-build", "test"]),
        stderrDigest: digest,
        stdoutDigest: digest,
        validationRoot: text,
      }),
    ),
    dependencyCacheContentDigest: digest,
    dependencyReceiptDigest: digest,
    digest,
    identityDigest: digest,
    proposalDigest: digest,
    status: z.literal("passed"),
    testShards: z.array(text),
    validatedByCallId: text,
    version: z.literal(3),
  }),
});

/** A canonical checkpoint must contain the full internally consistent receipt, not a status summary. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the canonical native checkpoint decoding boundary; its complete review is parsed and re-derived below.
const readReviewedWorkflow = (value: unknown): DraftReviewedWorkflow | undefined => {
  const parsed = reviewedSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  // SAFETY: Only an authenticated native checkpoint reaches this boundary; schema and the owning receipt derivation verify its complete review below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Re-derive every normalized review field and compare without relying on object key order.
  const reviewed = value as DraftReviewedWorkflow;
  const matches = [
    reviewed.appSpec.digest === reviewed.reviewReceipt.appSpecDigest,
    reviewed.sourceReceipt.digest === reviewed.reviewReceipt.sourceReceiptDigest,
    reviewed.proposal.digest === reviewed.reviewReceipt.proposalDigest,
    reviewed.identityReceipt.digest === reviewed.reviewReceipt.identityDigest,
    reviewed.workspace.workspaceDigest === reviewed.reviewReceipt.workspaceDigest,
    reviewed.dependencyReceipt.digest === reviewed.reviewReceipt.dependencyReceiptDigest,
    reviewed.appSpec.appId === reviewed.proposal.target.contract.appId,
  ].every(Boolean);
  if (!matches) {
    return undefined;
  }
  try {
    const normalized = deriveNormalizedChangeSet(
      {
        ...reviewed.applyReceipt,
        changedContentDigest: reviewed.reviewReceipt.changedContentDigest,
        changes: reviewed.reviewReceipt.changes,
        postTreeDigest: reviewed.reviewReceipt.postTreeDigest,
        preTreeDigest: reviewed.reviewReceipt.preTreeDigest,
      },
      reviewed.validationReceipt,
      reviewed.proposal.contractDigest,
      reviewed.sourceReceipt.contractDigest,
    );
    const receipt = createReviewedChangeSetReceipt(
      normalized,
      reviewed.reviewReceipt.reviewedByCallId,
    );
    return isDeepStrictEqual(receipt, reviewed.reviewReceipt) ? reviewed : undefined;
  } catch {
    return undefined;
  }
};

/** Compare only the stored JSON value; omitted undefined fields and key order are equivalent. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native checkpoints project untrusted workflow values for equality only.
export const samePersistedDraftReview = (left: unknown, right: unknown): boolean => {
  try {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    if (leftJson === undefined || rightJson === undefined) {
      return leftJson === rightJson;
    }
    return isDeepStrictEqual(JSON.parse(leftJson), JSON.parse(rightJson));
  } catch {
    return false;
  }
};

const latestReviewedCheckpoint = (
  candidates: z.infer<typeof checkpointSchema>[],
  selectedSlot: number,
): z.infer<typeof checkpointSchema> | undefined => {
  let latest: z.infer<typeof checkpointSchema> | undefined;
  let conflicting = false;
  for (const entry of candidates) {
    const { slot } = entry.origin;
    if (
      slot >= selectedSlot ||
      !z.object({ phase: z.literal("reviewed") }).safeParse(entry.serializedContext[workflowKey])
        .success
    ) {
      continue;
    }
    if (latest === undefined || slot > latest.origin.slot) {
      latest = entry;
      conflicting = false;
    } else if (
      slot === latest.origin.slot &&
      !samePersistedDraftReview(
        entry.serializedContext[workflowKey],
        latest.serializedContext[workflowKey],
      )
    ) {
      conflicting = true;
    }
  }
  return conflicting ? undefined : latest;
};

export interface DraftReviewedLineageRecoveryInput {
  descriptor: { logicalSessionId: string; sourceOwnerRunId: string };
  binding: { ownerRunId: string; logicalSessionId: string };
  payload: unknown;
  selectedOrigin: { slot: number; stepId: string; eventId: string };
  serializedContext: Readonly<z.infer<typeof contextSchema>>;
}

interface RecoveryContext {
  payload: z.infer<typeof payloadSchema>;
  selected: z.infer<typeof originSchema>;
  context: Readonly<z.infer<typeof contextSchema>>;
}

/** Verify the selected live checkpoint before looking at either current or prior owner history. */
const recoveryContext = (input: DraftReviewedLineageRecoveryInput): RecoveryContext | undefined => {
  const payload = payloadSchema.safeParse(input.payload).data;
  const selected = originSchema.safeParse(input.selectedOrigin).data;
  if (payload === undefined || selected === undefined) {
    return undefined;
  }
  const bound = [
    input.binding.ownerRunId === input.descriptor.sourceOwnerRunId,
    input.binding.logicalSessionId === input.descriptor.logicalSessionId,
    isDeepStrictEqual(payload.binding, input.binding),
    input.serializedContext["eve.sessionId"] === input.descriptor.logicalSessionId,
  ].every(Boolean);
  if (!bound) {
    return undefined;
  }
  const matches = payload.candidates.filter((entry) => isDeepStrictEqual(entry.origin, selected));
  if (
    matches.length !== 1 ||
    !isDeepStrictEqual(matches[0].serializedContext, input.serializedContext) ||
    payload.candidates.some(
      (entry) =>
        entry.serializedContext["eve.sessionId"] !== input.descriptor.logicalSessionId ||
        entry.sessionState.snapshot.session.sessionId !== input.descriptor.logicalSessionId,
    )
  ) {
    return undefined;
  }
  const context = input.serializedContext;
  const current = workflowSchema.safeParse(context[workflowKey]).data;
  const candidate = candidateSchema.safeParse(context[candidateKey]).data;
  if (
    current === undefined ||
    candidate === undefined ||
    current.phase === "reviewed" ||
    candidate.reviewedLineage !== undefined
  ) {
    return undefined;
  }
  return { context, payload, selected };
};

const hasCurrentReview = (context: RecoveryContext): boolean =>
  context.payload.candidates.some(
    (entry) =>
      entry.origin.slot <= context.selected.slot &&
      z.object({ phase: z.literal("reviewed") }).safeParse(entry.serializedContext[workflowKey])
        .success,
  );

// Historical values are authenticated native checkpoints, parsed and re-derived before use.
const checkedLineage = (
  context: RecoveryContext,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The historical checkpoint is parsed and its full review receipt re-derived below.
  value: unknown,
): DraftReviewedWorkflow | undefined => {
  const reviewed = readReviewedWorkflow(value);
  if (reviewed === undefined) {
    return undefined;
  }
  // SAFETY: Canonical checkpoint state was structurally checked above; the resolver verifies every source/app/apply/publication binding.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the checked resolver can authorize lineage.
  const candidate = context.context[candidateKey] as DraftReconciliationCandidate;
  // SAFETY: The resolver's identity fields were parsed by workflowSchema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This assertion does not itself grant authority.
  const workflow = context.context[workflowKey] as AppBuilderWorkflowState;
  if (
    resolveDraftReviewedWorkflow(workflow, { ...candidate, reviewedLineage: reviewed }) !== reviewed
  ) {
    return undefined;
  }
  return structuredClone(reviewed);
};

/** Add only authenticated historical app-review lineage; never roll back workflow or candidate. */
export const recoverDraftReviewedLineage = (
  input: DraftReviewedLineageRecoveryInput,
): DraftReviewedWorkflow | undefined => {
  const context = recoveryContext(input);
  if (context === undefined) {
    return undefined;
  }
  if (
    context.payload.candidates.some(
      (entry) =>
        entry.origin.slot === context.selected.slot &&
        z.object({ phase: z.literal("reviewed") }).safeParse(entry.serializedContext[workflowKey])
          .success,
    )
  ) {
    return undefined;
  }
  const latest = latestReviewedCheckpoint(context.payload.candidates, context.selected.slot);
  return latest === undefined
    ? undefined
    : checkedLineage(context, latest.serializedContext[workflowKey]);
};

/** An incompatible or conflicting current-owner review must not fall back to older history. */
export const maySearchPreviousDraftReviews = (
  input: DraftReviewedLineageRecoveryInput,
): boolean => {
  const context = recoveryContext(input);
  return context !== undefined && !hasCurrentReview(context);
};

/** Only the first (newest) verified prior-owner review may restore the original lineage. */
export const recoverPreviousDraftReview = (
  input: DraftReviewedLineageRecoveryInput,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native SDK projects this checkpoint value for validation.
  value: unknown,
): DraftReviewedWorkflow | undefined => {
  const context = recoveryContext(input);
  if (context === undefined || hasCurrentReview(context)) {
    return undefined;
  }
  return checkedLineage(context, value);
};
