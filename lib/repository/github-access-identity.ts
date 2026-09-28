import type { z } from "zod";

import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { assertExactInstallationIdentity } from "./github-publication";
import type { GitHubInstallationIdentity } from "./github-publication";
import { parseGitHubTargetAccessProof } from "./github-target-access-proof";
import type { GitHubTargetAccessProof } from "./github-target-access-proof";

export type GitHubAccessIdentity = GitHubInstallationIdentity | GitHubTargetAccessProof;

/** Validates a saved v2 identity or a tenant-bound v3 target proof. */
export const assertGitHubAccessIdentityForRepository = (input: {
  authority: z.input<typeof hostedTenantAuthoritySchema>;
  identity: GitHubAccessIdentity;
  repositoryId: string;
  operation: "resolve-existing-source" | "publish-draft-pull-request";
}): void => {
  if (input.identity.operation !== input.operation) {
    throw new Error("github-access-operation-mismatch");
  }
  if (input.identity.version === 2) {
    assertExactInstallationIdentity(input.identity);
    if (!input.identity.selectedRepositoryIds.includes(input.repositoryId)) {
      throw new Error("github-access-target-mismatch");
    }
    return;
  }
  parseGitHubTargetAccessProof(input.identity, input.authority);
  if (input.identity.repositoryId !== input.repositoryId) {
    throw new Error("github-access-target-mismatch");
  }
};
