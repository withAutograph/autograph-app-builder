import type { SandboxSession } from "eve/sandbox";

import { githubSandboxCredentialPolicy } from "../repository/github-sandbox-credentials";

const verifiedRepositoryFetchRejected = (error: Error): boolean =>
  /Builder could not fetch the current (?:draft head|base branch) \(exit 128\)/u.test(
    error.message,
  ) && /remote: Repository not found\./u.test(error.message);

/** Retry only a Git transport rejection after repository access was verified. */
export const prepareWithVerifiedGitHubFetchRecovery = async <T>(input: {
  acquireCredential: () => Promise<{ token: string }>;
  prepare: () => Promise<T>;
  sandbox: Pick<SandboxSession, "setNetworkPolicy">;
}): Promise<{ prepared: T; retriedGitFetch: boolean }> => {
  const attempt = async (): Promise<T> => {
    const credential = await input.acquireCredential();
    await input.sandbox.setNetworkPolicy(githubSandboxCredentialPolicy(credential.token));
    try {
      return await input.prepare();
    } finally {
      await input.sandbox.setNetworkPolicy("allow-all");
    }
  };
  try {
    return { prepared: await attempt(), retriedGitFetch: false };
  } catch (error) {
    if (!(error instanceof Error) || !verifiedRepositoryFetchRejected(error)) {
      throw error;
    }
  }
  try {
    return { prepared: await attempt(), retriedGitFetch: true };
  } catch (error) {
    if (error instanceof Error && verifiedRepositoryFetchRejected(error)) {
      throw new Error(
        "Builder verified this repository through its GitHub installation, but the sandbox Git fetch of the current draft or base returned 'Repository not found' twice. The selected repository exists and the installation has access; check delivery of the fresh installation credential to sandbox Git and the provider's Git transport, then retry private preparation. No draft branch was changed.",
        { cause: error },
      );
    }
    throw error;
  }
};
