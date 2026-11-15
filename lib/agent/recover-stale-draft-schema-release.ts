import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";

import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { inspectDraftReconciliation } from "../repository/sandbox-draft-reconciliation";
import {
  DraftSchemaReleaseMoveUncertainError,
  draftSchemaReleaseId,
  preserveStaleDraftSchemaRelease,
} from "../repository/sandbox-draft-schema-release";
import { retainedPrivateDraftSchemaGrant } from "./direct-production-state";
import {
  draftReconciliationState,
  samePersistedDraftCandidate,
  updateExactDraftReconciliation,
} from "./draft-reconciliation-state";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { DraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { readInstalledSchemaPredecessor } from "./installed-schema-predecessor-readback";
import { assertOwnedDraftSchemaCandidate } from "./owned-draft-schema-candidate";

const report = (reason: string) => {
  console.info(JSON.stringify({ event: "app_builder.draft_schema_recovery", reason }));
};

/** Recover known stale compiler output before any new validation or review can use it. */
export const recoverStaleDraftSchemaRelease = async (input: {
  candidate: DraftReconciliationCandidate;
  ctx: ToolContext;
  sandbox: SandboxSession;
  source: ImmutableGitHubSourceReceipt;
  state: DraftReviewedWorkflow;
  inspected: Awaited<ReturnType<typeof inspectDraftReconciliation>>;
}): Promise<DraftReconciliationCandidate> => {
  const { candidate, ctx, sandbox, source, state, inspected } = input;
  if (candidate.kind === "published-draft-repair") {
    return candidate;
  }
  const { appId } = candidate;
  const schemaPath = `apps/${appId}/schema`;
  const releasePrefix = `${schemaPath}/release/`;
  const cue = inspected.baseChanges.find(({ path }) => path === `${schemaPath}/${appId}.cue`);
  const cuts = inspected.baseChanges.flatMap(({ path, kind }) => {
    if (kind !== "added" || !path.startsWith(releasePrefix)) {
      return [];
    }
    const [releaseId, filename, nested] = path.slice(releasePrefix.length).split("/");
    const id = draftSchemaReleaseId.safeParse(releaseId);
    return id.success && filename === "release-manifest.json" && nested === undefined
      ? [id.data]
      : [];
  });
  if (cue?.before === undefined || cue.after === undefined || cuts.length !== 1) {
    return candidate;
  }
  const authorization = retainedPrivateDraftSchemaGrant(ctx, candidate);
  if (authorization === null) {
    return candidate;
  }
  const [releaseId] = cuts;
  const { grant, schemaChange } = authorization;
  const assertCurrent = () => {
    ctx.abortSignal.throwIfAborted();
    const current = retainedPrivateDraftSchemaGrant(ctx, candidate);
    if (
      current?.grant.digest !== grant.digest ||
      !samePersistedDraftCandidate(draftReconciliationState.get(), candidate)
    ) {
      throw new Error("The approved private draft changed before schema recovery.");
    }
  };
  const preimageTree = candidate.validation?.resolvedTree ?? candidate.schemaRecoveryPreimageTree;
  const invalidateOldProof = (uncertain: boolean) => {
    let updated = candidate;
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "regenerating an unissued checked schema release",
      transition: () => {
        updated = { ...candidate };
        delete updated.proposal;
        delete updated.review;
        delete updated.reviewReadProgress;
        delete updated.validation;
        delete updated.validationRun;
        delete updated.schemaRecoveryPreimageTree;
        if (uncertain && preimageTree !== undefined) {
          updated.schemaRecoveryPreimageTree = preimageTree;
        }
        return updated;
      },
    });
    return updated;
  };
  let observation = "installed-predecessor-unavailable";
  try {
    const installed = await readInstalledSchemaPredecessor(appId, ctx);
    if (
      installed.appId !== appId ||
      installed.repositoryId !== candidate.repositoryId ||
      installed.cueSha256 !== cue.before.digest ||
      inspected.baseChanges.some(({ path }) =>
        path.startsWith(`${releasePrefix}${installed.releaseId}/`),
      )
    ) {
      report("installed-predecessor-mismatch");
      return candidate;
    }
    observation = "owned-draft-unavailable";
    await assertOwnedDraftSchemaCandidate({
      candidate,
      ctx,
      source,
      state,
      expectedInstallationId: grant.subject.installationId,
    });
    observation = "checked-output-unverified";
    const preserved = await preserveStaleDraftSchemaRelease({
      prepared: candidate,
      releaseId,
      validatedTree: preimageTree,
      sandbox,
      abortSignal: ctx.abortSignal,
      assertCurrent,
      markUncertain: () => {
        if (samePersistedDraftCandidate(draftReconciliationState.get(), candidate)) {
          invalidateOldProof(true);
        }
      },
      recovery: {
        approvedCandidateCueSha256: schemaChange.candidateCueSha256,
        approvedPriorCueSha256: schemaChange.priorCueSha256,
        privateCueSha256: cue.after.digest,
        inspectedTree: inspected.resolvedTree,
        installed: {
          releaseId: installed.releaseId,
          artifactSha256: installed.artifactSha256,
          manifestSha256: installed.manifestSha256,
          cueSha256: installed.cueSha256,
        },
      },
    });
    if (preserved === undefined) {
      return candidate;
    }
    report("regenerate-unissued-output");
    return invalidateOldProof(false);
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    if (error instanceof DraftSchemaReleaseMoveUncertainError) {
      throw error;
    }
    assertCurrent();
    report(observation);
    // Missing evidence cannot authorize a repair. Ordinary validation and publication checks still apply.
    return candidate;
  }
};
