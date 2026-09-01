import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import {
  assertRepositoryAccessReceiptForSource,
  assertResolvedSourceMatchesRepositoryAccess,
  repositoryAccessReceiptState,
} from "@/lib/agent/repository-access-state";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export default defineTool({
  description:
    "After Store In records a session-bound GitHub access receipt, automatically resolve its private repository ref to an exact immutable SHA/tree receipt. The provider is independently re-read and repository, ref, SHA, tree, and installation drift are rejected. It does not clone, create, push, branch, open a PR, or alter a release gate.",
  inputSchema: z.strictObject({
    expectedSourceReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedRepositoryAccessDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    repositoryId: z.string().regex(/^\d+$/u),
    ref: z.string().min(1).max(255),
    expectedSha: objectId,
    expectedTree: objectId,
  }),
  approval: never(),
  async execute(input, ctx) {
    const source = sourceWorkflowState.get();
    if (
      source.phase === "empty" ||
      source.receipt.sourceKind !== "existing-repository"
    )
      throw new Error("No reviewed existing-repository source is available.");
    if (
      source.receipt.digest !== input.expectedSourceReceiptDigest ||
      source.receipt.sourceSha !== input.expectedSha ||
      source.receipt.sourceTree !== input.expectedTree
    )
      throw new Error(
        "The GitHub source request is not bound to the exact reviewed source receipt.",
      );
    const access = assertRepositoryAccessReceiptForSource({
      receipt: repositoryAccessReceiptState.get(),
      expectedDigest: input.expectedRepositoryAccessDigest,
      sessionId: ctx.session.id,
      repositoryId: input.repositoryId,
      ref: input.ref,
      expectedSha: input.expectedSha,
      expectedTree: input.expectedTree,
    });
    if (
      source.githubSource !== undefined &&
      (source.githubSource.repository.repositoryId !== input.repositoryId ||
        source.githubSource.resolvedRef !== input.ref)
    )
      throw new Error(
        "This source is already bound to a different GitHub ref.",
      );
    if (source.githubSource !== undefined) {
      assertExactImmutableGitHubSourceReceipt(source.githubSource);
      if (
        source.githubSource.resolvedSha !== input.expectedSha ||
        source.githubSource.resolvedTree !== input.expectedTree
      )
        throw new Error("The persisted GitHub source receipt is stale.");
    }

    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    const receipt = await runtime.resolveImmutableSource({
      expectedInstallationId: access.scope.installationId,
      repositoryId: input.repositoryId,
      ref: input.ref,
      expectedSha: input.expectedSha,
      expectedTree: input.expectedTree,
      approvedByCallId: ctx.callId,
    });
    assertExactImmutableGitHubSourceReceipt(receipt);
    assertResolvedSourceMatchesRepositoryAccess({ access, source: receipt });
    if (
      receipt.resolvedSha !== source.receipt.sourceSha ||
      receipt.resolvedTree !== source.receipt.sourceTree
    )
      throw new Error("The immutable GitHub receipt changed after resolution.");

    if (source.githubSource !== undefined) {
      if (
        JSON.stringify(source.githubSource.repository) !==
          JSON.stringify(receipt.repository) ||
        source.githubSource.resolvedRef !== receipt.resolvedRef ||
        source.githubSource.resolvedSha !== receipt.resolvedSha ||
        source.githubSource.resolvedTree !== receipt.resolvedTree ||
        source.githubSource.installationIdentityDigest !==
          receipt.installationIdentityDigest
      )
        throw new Error("The persisted GitHub source receipt is stale.");
      return source.githubSource;
    }

    sourceWorkflowState.update((latest) => {
      if (JSON.stringify(latest) !== JSON.stringify(source))
        throw new Error(
          "The reviewed source changed concurrently before GitHub resolution was recorded.",
        );
      return { ...source, githubSource: receipt };
    });
    return receipt;
  },
});
