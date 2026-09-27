import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";

import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "@/lib/agent/repository-access-tool";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import { inspectGitHubSourceSandboxWorkspace } from "@/lib/repository/sandbox-github-source";

const inspectDraftRevision = async (input: {
  sessionAuth: unknown;
  repository: { name: string; owner: string; repositoryId: string };
  pullRequestNumber: number | undefined;
}) => {
  if (input.pullRequestNumber === undefined) {
    return input.pullRequestNumber;
  }
  const publicationRuntime = await githubPublicationRuntimeForSession(input.sessionAuth);
  return await publicationRuntime.inspectExistingDraftSource({
    name: input.repository.name,
    owner: input.repository.owner,
    pullRequestNumber: input.pullRequestNumber,
    repositoryId: input.repository.repositoryId,
  });
};

const assertRetryDraftBranch = async (input: {
  draftPullRequestNumber: number | undefined;
  repository: { defaultBranch: string; name: string; owner: string; repositoryId: string };
  resolvedRef: string;
  sessionAuth: unknown;
}) => {
  if (input.draftPullRequestNumber === undefined) {
    return;
  }
  if (input.resolvedRef === `refs/heads/${input.repository.defaultBranch}`) {
    throw new Error(
      "This Builder session already uses the repository's default branch. Start a new Builder session and select the draft PR number before preparing its source; the occupied checkout will not be replaced.",
    );
  }
  const draft = await inspectDraftRevision({
    pullRequestNumber: input.draftPullRequestNumber,
    repository: input.repository,
    sessionAuth: input.sessionAuth,
  });
  if (draft === undefined || input.resolvedRef !== `refs/heads/${draft.headBranch}`) {
    throw new Error(
      "This Builder session is bound to a different draft PR branch. Start a new Builder session and select the intended draft PR before preparing its source.",
    );
  }
};

export const inputSchema = z.strictObject({
  draftPullRequestNumber: z.number().int().positive().optional(),
  repository: z
    .string()
    .min(3)
    .max(201)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  selectedInstallationId: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .nullable()
    .transform((value) => value ?? undefined),
});

export default defineTool({
  approval: never(),
  description:
    "Resolve and prepare an existing connected GitHub repository. To revise an existing draft PR, provide its number in a new Builder session; Builder verifies the open draft and uses its current branch as the writable source. Pass selectedInstallationId=null for the single verified installation. This operation never pushes, branches, opens a PR, or alters a release gate.",
  async execute(input, ctx) {
    const initialWorkflow = appBuilderWorkflowState.get();
    const initialSource = sourceWorkflowState.get();
    assertUpstreamMutationAllowed(initialWorkflow, "GitHub source preparation");
    if (
      (initialSource.phase !== "empty" && initialSource.githubSource === undefined) ||
      (initialWorkflow.phase !== "empty" && initialWorkflow.githubSource === undefined)
    ) {
      throw new Error(
        "This app build already uses the starter source. Start a new app build to select an existing GitHub repository.",
      );
    }
    if (
      initialSource.phase !== "empty" &&
      initialSource.githubSource !== undefined &&
      `${initialSource.githubSource.repository.owner}/${initialSource.githubSource.repository.name}` !==
        input.repository
    ) {
      throw new Error("This app build already uses a different GitHub repository.");
    }
    const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
    const access = await resolveRepositoryAccessForTool(input, ctx, runtime);
    if (access.kind === "selection") {
      return access.access;
    }

    if (
      initialSource.phase !== "empty" &&
      initialWorkflow.phase !== "empty" &&
      initialSource.githubSource !== undefined &&
      initialWorkflow.githubSource !== undefined
    ) {
      await assertRetryDraftBranch({
        draftPullRequestNumber: input.draftPullRequestNumber,
        repository: access.access.repository,
        resolvedRef: initialSource.githubSource.resolvedRef,
        sessionAuth: ctx.session.auth,
      });
      // A retry keeps the selected repository binding and observes the live
      // checkout. GitHub's default branch may have advanced since selection.
      if (
        initialWorkflow.githubSource.digest !== initialSource.githubSource.digest ||
        initialSource.githubSource.repository.repositoryId !== access.access.repository.repositoryId
      ) {
        throw new Error("This app build already owns a different GitHub repository.");
      }
      const workspace = await inspectGitHubSourceSandboxWorkspace({
        githubSource: initialSource.githubSource,
        sandbox: await ctx.getSandbox(),
      });
      return {
        githubSource: initialSource.githubSource,
        repository: access.access.repository,
        repositoryAccessReceiptDigest: access.receipt.digest,
        scope: access.access.scope,
        sourceReceipt: initialSource.receipt,
        workspace,
      };
    }

    const draftRevision = await inspectDraftRevision({
      pullRequestNumber: input.draftPullRequestNumber,
      repository: access.access.repository,
      sessionAuth: ctx.session.auth,
    });

    const prepared = await runtime.prepareExistingSource({
      ...input,
      access: access.access,
      callId: ctx.callId,
      currentAccessReceipt: access.receipt,
      ...(draftRevision === undefined
        ? {}
        : {
            revision: {
              branch: draftRevision.headBranch,
              headSha: draftRevision.headSha,
              headTree: draftRevision.headTree,
            },
          }),
      // Source credentials are resolved first. The backend consumes the
      // server-owned context while `getSandbox()` creates the provider
      // session, so Vercel performs the Git clone itself.
      ...(initialSource.phase === "empty" || initialSource.githubSource === undefined
        ? {}
        : { currentGitHubSource: initialSource.githubSource }),
      sandbox: () => ctx.getSandbox(),
      sessionId: ctx.session.id,
    });
    assertExactImmutableGitHubSourceReceipt(prepared.githubSource);
    repositoryAccessReceiptState.update((current) => {
      if (current?.digest !== access.receipt.digest) {
        throw new Error("Repository access changed concurrently during source preparation.");
      }
      return prepared.accessReceipt;
    });
    sourceWorkflowState.update((current) => {
      if (JSON.stringify(current) !== JSON.stringify(initialSource)) {
        throw new Error(
          "The reviewed source changed concurrently during GitHub source preparation.",
        );
      }
      if (current.phase !== "empty") {
        if (
          current.receipt.digest !== prepared.sourceReceipt.digest ||
          current.githubSource?.digest !== prepared.githubSource.digest
        ) {
          throw new Error("This app build already owns a different GitHub source binding.");
        }
        return current;
      }
      return {
        githubSource: prepared.githubSource,
        phase: "reviewed",
        receipt: prepared.sourceReceipt,
        version: APP_BUILDER_SOURCE_VERSION,
      };
    });
    appBuilderWorkflowState.update((current) => {
      assertExactWorkflowState(current, initialWorkflow, "GitHub source preparation");
      if (current.phase !== "empty") {
        if (
          workflowWorkspace(current)?.workspaceDigest !== prepared.workspace.workspaceDigest ||
          current.sourceReceipt.digest !== prepared.sourceReceipt.digest ||
          current.githubSource?.digest !== prepared.githubSource.digest
        ) {
          throw new Error("This app build already owns a different GitHub source binding.");
        }
        return current;
      }
      return {
        artifacts: [],
        githubSource: prepared.githubSource,
        phase: "prepared",
        preparedByCallId: ctx.callId,
        sourceReceipt: prepared.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: prepared.workspace,
      };
    });
    return {
      githubSource: prepared.githubSource,
      repository: access.access.repository,
      repositoryAccessReceiptDigest: prepared.accessReceipt.digest,
      scope: access.access.scope,
      sourceReceipt: prepared.sourceReceipt,
      workspace: prepared.workspace,
    };
  },
  inputSchema,
});
