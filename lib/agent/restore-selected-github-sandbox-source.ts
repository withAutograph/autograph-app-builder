import type { ImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import type { RepositoryAccessReceipt } from "@/lib/agent/repository-access-state";
import type { RepositoryAccessRuntime } from "@/lib/agent/deployment-repository-access-runtime";
import {
  clearVercelSessionGitSource,
  configureVercelSessionGitSourceResolver,
} from "@/lib/sandbox/vercel-session-source";

/** Registers a tenant-bound source without a GitHub call on a healthy resume. */
export const restoreSelectedGitHubSandboxSource = (input: {
  sessionId: string;
  githubSource: ImmutableGitHubSourceReceipt | undefined;
  frozenRevision?: string;
  accessReceipt: RepositoryAccessReceipt | undefined;
  runtime: () => Promise<Pick<RepositoryAccessRuntime, "acquireExistingSourceCredential">>;
}): void => {
  const { githubSource, accessReceipt, sessionId } = input;
  // An earlier turn's installation token may have expired or lost access.
  clearVercelSessionGitSource(sessionId);
  if (githubSource === undefined) {
    return;
  }
  const { repository } = githubSource;
  const sameSession = accessReceipt?.sessionId === sessionId;
  const sameRepository =
    accessReceipt?.repository.repositoryId === repository.repositoryId &&
    accessReceipt.repository.owner === repository.owner &&
    accessReceipt.repository.name === repository.name;
  if (accessReceipt === undefined || !sameSession || !sameRepository) {
    throw new Error(
      `Builder cannot restore the selected checkout for ${repository.owner}/${repository.name}: its saved repository access belongs to another session or repository. Reconnect the intended repository in a new Builder session; no replacement checkout was created.`,
    );
  }
  const branchPrefix = "refs/heads/";
  if (!githubSource.resolvedRef.startsWith(branchPrefix)) {
    throw new Error(
      `Builder cannot restore the selected checkout for ${repository.owner}/${repository.name}: the saved GitHub source is not a branch. Select the repository branch in a new Builder session.`,
    );
  }
  configureVercelSessionGitSourceResolver({
    async resolve() {
      const runtime = await input.runtime();
      const credential = await runtime.acquireExistingSourceCredential({
        installationId: accessReceipt.scope.installationId,
        repository: {
          name: repository.name,
          owner: repository.owner,
          repositoryId: repository.repositoryId,
        },
        sessionId,
      });
      return {
        revision: input.frozenRevision ?? githubSource.resolvedRef.slice(branchPrefix.length),
        token: credential.token,
        url: `https://github.com/${repository.owner}/${repository.name}.git`,
      };
    },
    sessionId,
  });
};

/** Recover pre-migration sessions whose accepted app retained the source after source state was reset. */
export const selectedGitHubSourceForSandboxRestore = (input: {
  sourceState: ImmutableGitHubSourceReceipt | undefined;
  workflowState: ImmutableGitHubSourceReceipt | undefined;
}): ImmutableGitHubSourceReceipt | undefined => {
  if (
    input.sourceState !== undefined &&
    input.workflowState !== undefined &&
    (input.sourceState.repository.repositoryId !== input.workflowState.repository.repositoryId ||
      input.sourceState.resolvedRef !== input.workflowState.resolvedRef)
  ) {
    throw new Error(
      "Builder cannot restore a saved checkout: source and accepted app refer to different GitHub repositories or branches. Reopen the intended repository branch in a new Builder session.",
    );
  }
  // The accepted app owns its original repository binding. A later inspection
  // may observe the same branch at a newer head without replacing that binding.
  return input.workflowState ?? input.sourceState;
};
