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

const workflowKey = "autograph-app-builder.workflow.v17";
export const draftReviewedLineageContextKey = "autograph-app-builder.draft-reconciliation.v1";
const candidateKey = draftReviewedLineageContextKey;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const executionBinding = z.looseObject({
  sourceSha: sha,
  sourceTree: sha,
  sourceReceiptDigest: digest,
  eligibilityDigest: digest,
  workspaceDigest: digest,
  imageDigest: digest,
  dependencyCacheDigest: digest,
  appSpecDigest: digest,
  artifactRevision: text,
});
const overlayFile = z.looseObject({ path: text, mode: text, digest });
const applySchema = executionBinding.extend({
  version: z.literal(2),
  status: z.literal("applied"),
  digest,
  applyRoot: text,
  appSpecPath: text,
  dependencyReceiptDigest: digest,
  identityDigest: digest,
  dependencyCacheContentDigest: digest,
  proposalDigest: digest,
  planningTreeDigest: digest,
  preparedTreeDigest: digest,
  preTree: z.array(overlayFile),
  preTreeDigest: digest,
  postTree: z.array(overlayFile),
  postTreeDigest: digest,
  changes: z.array(z.looseObject({ kind: z.enum(["added", "removed", "modified"]), path: text })),
  changedContentDigest: digest,
  appliedByCallId: text,
  targetReceipt: targetApplyCommandReceiptSchema,
  command: z.looseObject({
    name: z.enum(["create-app", "iterate-existing-app"]),
    exitCode: z.literal(0),
    stdoutDigest: digest,
    stderrDigest: digest,
  }),
});
const originSchema = z.object({
  slot: z.number().int().nonnegative(),
  stepId: text,
  eventId: text,
});
const contextSchema = z.record(z.string(), z.unknown());
const checkpointSchema = z.object({
  origin: originSchema,
  serializedContext: contextSchema,
  sessionState: z.object({ snapshot: z.object({ session: z.object({ sessionId: text }) }) }),
});
const payloadSchema = z.object({
  binding: z.object({ ownerRunId: text, logicalSessionId: text }),
  candidates: z.array(checkpointSchema),
});
const candidateSchema = z.looseObject({
  version: z.literal(1),
  appId: text,
  githubSourceDigest: digest,
  originalReviewDigest: digest,
  repositoryId: text,
  root: text,
  reviewedLineage: z.unknown().optional(),
});
const workflowSchema = z.looseObject({
  phase: z.enum(["reviewed", "applied", "validation_pending", "validation_failed", "validated"]),
  appSpec: z.looseObject({
    appId: text,
    digest,
    artifactPath: text,
    artifactRevision: text,
    acceptedByCallId: text,
  }),
  applyReceipt: applySchema,
  sourceReceipt: z.looseObject({
    digest,
    sourceKind: z.literal("existing-repository"),
    contractDigest: digest,
  }),
  githubSource: z.looseObject({ digest, repository: z.looseObject({ repositoryId: text }) }),
  identityReceipt: executionBinding.extend({
    version: z.literal(1),
    identity: targetIdentitySchema,
    resolvedByCallId: text,
    digest,
  }),
  proposal: executionBinding.extend({
    version: z.literal(1),
    digest,
    contractDigest: digest,
    identityDigest: digest,
    target: targetProposalSchema,
    plannedByCallId: text,
  }),
  workspace: z.looseObject({
    workspaceId: text,
    workspaceDigest: digest,
    workspacePath: text,
    sourcePath: text,
    sourceSha: sha,
    sourceTree: sha,
    adapter: text,
    eligibilityDigest: digest,
  }),
});
const reviewedSchema = workflowSchema.extend({
  phase: z.literal("reviewed"),
  validationReceipt: executionBinding.extend({
    version: z.literal(3),
    digest,
    status: z.literal("passed"),
    attemptDigest: digest,
    testShards: z.array(text),
    appValidationSha256: digest,
    appSpecPath: text,
    dependencyReceiptDigest: digest,
    identityDigest: digest,
    dependencyCacheContentDigest: digest,
    proposalDigest: digest,
    applyDigest: digest,
    appliedTreeDigest: digest,
    changedContentDigest: digest,
    validatedByCallId: text,
    commands: z.array(
      z.looseObject({
        name: z.enum(["check-build", "test"]),
        command: text,
        validationRoot: text,
        inputTreeDigest: digest,
        exitCode: z.literal(0),
        stdoutDigest: digest,
        stderrDigest: digest,
      }),
    ),
  }),
  dependencyReceipt: executionBinding.extend({
    version: z.literal(2),
    digest,
    targetSha: sha,
    targetTree: sha,
    cacheManifestDigest: digest,
    cacheContentDigest: digest,
    dependencyLayout: executionDependencyLayoutSchema,
    preparedByCallId: text,
  }),
  artifacts: z.array(z.unknown()),
  preparedByCallId: text,
  reviewReceipt: z.looseObject({
    version: z.literal(2),
    digest,
    changeSetDigest: digest,
    reviewedByCallId: text,
    contractDigest: digest,
    repositoryContractDigest: digest,
    preTreeDigest: digest,
    postTreeDigest: digest,
    changedContentDigest: digest,
    changes: z.array(z.looseObject({ path: text })),
    approvedPaths: z.array(text),
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
        preTreeDigest: reviewed.reviewReceipt.preTreeDigest,
        postTreeDigest: reviewed.reviewReceipt.postTreeDigest,
        changedContentDigest: reviewed.reviewReceipt.changedContentDigest,
        changes: reviewed.reviewReceipt.changes,
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

const latestReviewedCheckpoint = (
  candidates: z.infer<typeof checkpointSchema>[],
  selectedSlot: number,
): z.infer<typeof checkpointSchema> | undefined => {
  let latest: z.infer<typeof checkpointSchema> | undefined;
  let conflicting = false;
  for (const entry of candidates) {
    const slot = entry.origin.slot;
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
      !isDeepStrictEqual(
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

/** Add only authenticated historical app-review lineage; no workflow rollback, new review or effect replay. */
export const recoverDraftReviewedLineage = (
  input: DraftReviewedLineageRecoveryInput,
): DraftReviewedWorkflow | undefined => {
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
  const latest = latestReviewedCheckpoint(payload.candidates, selected.slot);
  if (latest === undefined) {
    return undefined;
  }
  const reviewed = readReviewedWorkflow(latest.serializedContext[workflowKey]);
  if (reviewed === undefined) {
    return undefined;
  }
  // SAFETY: These values are canonical checkpoint state, structurally checked above; the shared lineage resolver verifies every source/app/apply/repository binding before returning authority.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The shared resolver consumes the validated subset and returns only the independently verified historical full review.
  const originalCandidate = context[candidateKey] as DraftReconciliationCandidate;
  const proposed = { ...originalCandidate, reviewedLineage: reviewed };
  // SAFETY: Only the resolver's closed identity fields are used, all parsed by workflowSchema above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- No assertion independently grants lineage recovery.
  const workflow = context[workflowKey] as AppBuilderWorkflowState;
  if (resolveDraftReviewedWorkflow(workflow, proposed) !== reviewed) {
    return undefined;
  }
  return structuredClone(reviewed);
};
