import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { draftReconciliationCompletions } from "./draft-reconciliation-state";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";

export const readMergedReleaseSourceRecovery = async (input: {
  current: {
    appSpec: { appId: string; digest: string };
    applyReceipt: { applyRoot: string; changes: readonly { path: string }[] };
    githubSource?: Pick<ImmutableGitHubSourceReceipt, "repository" | "resolvedRef"> | undefined;
  };
  releaseId: string;
  ctx: Pick<ToolContext, "abortSignal" | "callId" | "session">;
  installationId: string;
}) => {
  const { current, releaseId, ctx, installationId } = input;
  const source = current.githubSource;
  const { appId } = current.appSpec;
  const prefix = `apps/${appId}/schema/release/${releaseId}/`;
  if (
    source === undefined ||
    current.applyReceipt.changes.some(({ path }) => path.startsWith(prefix))
  ) {
    return null;
  }

  const matches = draftReconciliationCompletions.get().filter((completion) => {
    const { proposal, compilation } = completion;
    const sameSource = [
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
    const publicationDigest =
      completion.publishedOrigin?.publicationProposalDigest ??
      completion.publicationScope?.proposal.digest;
    if (publicationDigest === undefined) {
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
        publishedSource: {
          repositoryId: proposal.repositoryId,
          branch: proposal.branchName,
          gitSha: head,
        },
      },
    });
    if (
      retained === undefined ||
      retained.selection.publishedSource?.gitTree !== proposal.resolvedTree
    ) {
      continue;
    }
    ctx.abortSignal.throwIfAborted();
    return {
      mergeSha: merged.mergeCommitSha,
      releaseId,
      files: Object.fromEntries(
        Object.entries(retained.files).map(([member, content]) => [
          member,
          createHash("sha256").update(content).digest("hex"),
        ]),
      ),
    };
  }

  return null;
};
