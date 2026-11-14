import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { retainedProductionSourceReconciliation } from "./direct-production-state";
import { draftReconciliationCompletions } from "./draft-reconciliation-state";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { ExistingDraftReconciliationProposal } from "../repository/github-draft-reconciliation";
import type { PublishedPlanningRelease } from "../repository/planning-source-reconciliation";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";

type ReconciliationAnchor = ReturnType<typeof retainedProductionSourceReconciliation>;
const matchesAnchor = (
  anchor: NonNullable<ReconciliationAnchor>,
  proposal: ExistingDraftReconciliationProposal,
): boolean =>
  [
    anchor.digest === proposal.digest,
    anchor.originPublicationReceiptDigest === proposal.priorPublicationDigest,
    anchor.resolvedTree === proposal.resolvedTree,
    anchor.reviewDigest === proposal.reviewDigest,
    anchor.pullRequestNumber === proposal.pullRequestNumber,
    anchor.expectedHeadSha === proposal.expectedHeadSha,
    anchor.expectedBaseSha === proposal.expectedBaseSha,
  ].every(Boolean);

const compiledManifestSources = z.looseObject({
  app: z.string(),
  schema_version: z.string(),
  sources: z.record(z.string(), z.string()),
});
const cueSourceDigest = (
  bytes: Buffer | undefined,
  manifestSha256: string,
  appId: string,
  releaseId: string,
): string | null => {
  if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== manifestSha256) {
    return null;
  }
  try {
    const manifest = compiledManifestSources.safeParse(JSON.parse(bytes.toString("utf-8")));
    if (
      !manifest.success ||
      manifest.data.app !== appId ||
      manifest.data.schema_version !== releaseId
    ) {
      return null;
    }
    const source = manifest.data.sources[`apps/${appId}/schema/${appId}.cue`];
    return /^sha256:(?<digest>[a-f0-9]{64})$/u.exec(source ?? "")?.groups?.digest ?? null;
  } catch {
    // A malformed archived manifest cannot prove a CUE source digest.
    return null;
  }
};

/** Locate the exact earlier repair; provider and owned archive checks still follow. */
export const retainedMergedSchemaReleaseId = (
  proposalDigest: string,
  appId: string,
  reconciliationAnchor?: ReconciliationAnchor,
) => {
  const anchor = reconciliationAnchor ?? retainedProductionSourceReconciliation(proposalDigest);
  const prior = draftReconciliationCompletions
    .get()
    .find(
      (entry) =>
        entry.appId === appId &&
        entry.preparation === "sealed-before-approval" &&
        anchor !== undefined &&
        matchesAnchor(anchor, entry.proposal),
    );
  return prior?.compilation.release.status === "published"
    ? prior.compilation.release.selection.releaseId
    : undefined;
};

export const readMergedReleaseSourceRecovery = async (input: {
  current: {
    appSpec: { appId: string; digest: string };
    proposal: { digest: string };
    applyReceipt: { applyRoot: string; changes: readonly { path: string }[] };
    githubSource?: Pick<ImmutableGitHubSourceReceipt, "repository" | "resolvedRef"> | undefined;
  };
  releaseId: string;
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "session">;
  installationId: string;
  includeSchemaCue?: true;
  reconciliationAnchor?: ReconciliationAnchor;
}): Promise<(PublishedPlanningRelease & { cueSha256?: string }) | null> => {
  const { current, releaseId, ctx, installationId } = input;
  const source = current.githubSource;
  const { appId } = current.appSpec;
  const prefix = `apps/${appId}/schema/release/${releaseId}/`;
  // In delivered-source planning the historical apply belongs to the release
  // being read. The explicit anchor still has to prove that exact merge below.
  const readDeliveredSchema =
    input.includeSchemaCue === true && input.reconciliationAnchor !== undefined;
  if (
    source === undefined ||
    (!readDeliveredSchema &&
      current.applyReceipt.changes.some(({ path }) => path.startsWith(prefix)))
  ) {
    return null;
  }

  const anchor =
    input.reconciliationAnchor ?? retainedProductionSourceReconciliation(current.proposal.digest);
  const matches = draftReconciliationCompletions.get().filter((completion) => {
    const { proposal, compilation } = completion;
    if (
      input.reconciliationAnchor !== undefined &&
      !matchesAnchor(input.reconciliationAnchor, proposal)
    ) {
      return false;
    }
    const sameSource = [
      completion.preparation === "sealed-before-approval",
      completion.appId === appId,
      proposal.repositoryId === source.repository.repositoryId,
      proposal.owner === source.repository.owner,
      proposal.name === source.repository.name,
      `refs/heads/${proposal.baseBranch}` === source.resolvedRef,
    ].every(Boolean);
    return (
      sameSource &&
      compilation.release.status === "published" &&
      compilation.release.selection.releaseId === releaseId
    );
  });

  if (matches.length === 0) {
    return null;
  }
  const runtime = await githubPublicationRuntimeForSession(ctx.session.auth, {
    selectedInstallationId: installationId,
  });
  if (
    runtime.inspectPublishedReconciliationHead === undefined ||
    runtime.inspectPublishedPullRequest === undefined
  ) {
    return null;
  }

  // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Eliminate unmerged and unrecorded candidates before reading the next safe match.
  for (const completion of matches.toReversed()) {
    const { proposal, compilation } = completion;
    if (compilation.release.status !== "published") {
      continue;
    }
    const { selection } = compilation.release;
    const anchored = anchor !== undefined && matchesAnchor(anchor, proposal);
    const publicationDigest =
      completion.publishedOrigin?.publicationProposalDigest ??
      completion.publicationScope?.proposal.digest ??
      (anchored ? anchor.originPublicationDigest : undefined);
    if (
      publicationDigest === undefined ||
      (input.reconciliationAnchor !== undefined &&
        publicationDigest !== input.reconciliationAnchor.originPublicationDigest)
    ) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Only the exact provider-verified recorded correction can restore the private copy.
    const head = await runtime.inspectPublishedReconciliationHead(publicationDigest, proposal);
    if (head === null) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- The reread must use the just-observed reconciled head.
    const merged = await runtime.inspectPublishedPullRequest(publicationDigest, head);
    const mergeMatches = [
      merged.reviewedRevision,
      merged.state === "merged",
      merged.reviewedTarget.repositoryId === proposal.repositoryId,
      merged.reviewedTarget.pullRequestNumber === proposal.pullRequestNumber,
    ].every(Boolean);
    if (!mergeMatches || merged.mergeCommitSha === undefined) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Resolve archive bytes only for the exact merged publication and current owned session.
    const retained = await readExactCompiledOperatorReleaseForSession({
      adapterSessionId: ctx.session.id,
      appId,
      appSpecDigest: current.appSpec.digest,
      callId: ctx.callId,
      callbackExecution: hostedOperatorCallbackExecution(ctx.session),
      root: current.applyReceipt.applyRoot,
      sessionAuth: ctx.session.auth,
      signal: ctx.abortSignal,
      lookup: {
        artifactRef: selection.artifactRef,
        appSpecDigest: selection.appSpecDigest,
      },
    });
    const retainedMatches = [
      retained?.selection.releaseId === releaseId,
      retained?.selection.schemaSha256 === selection.schemaSha256,
      retained?.selection.manifestSha256 === selection.manifestSha256,
      retained?.selection.publishedSource === undefined ||
        retained.selection.publishedSource.gitTree === proposal.resolvedTree,
    ].every(Boolean);
    if (retained === undefined || !retainedMatches) {
      continue;
    }
    ctx.abortSignal.throwIfAborted();
    const result: PublishedPlanningRelease & { cueSha256?: string } = {
      mergeSha: merged.mergeCommitSha,
      releaseId,
      files: Object.fromEntries(
        Object.entries(retained.files).map(([member, content]) => [
          member,
          createHash("sha256").update(content).digest("hex"),
        ]),
      ),
    };
    if (input.includeSchemaCue === true) {
      const cueSha256 = cueSourceDigest(
        retained.files["release-manifest.json"],
        selection.manifestSha256,
        appId,
        releaseId,
      );
      if (cueSha256 === null) {
        continue;
      }
      result.cueSha256 = cueSha256;
    }
    return result;
  }

  return null;
};
