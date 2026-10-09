import { createHash } from "node:crypto";

import {
  assertExactRepositoryObservation,
  assertExactInstallationIdentity,
  createRepositoryObservation,
  createGitHubInstallationIdentity,
} from "./github-publication";
import type { GitHubRepositoryObservation, GitHubInstallationIdentity } from "./github-publication";
import { safeSourcePath } from "./source-path";
import { canonicalOverlayFiles, compareOverlayPaths, overlayChanges } from "./target-apply";
import type { OverlayChange, OverlayFile, OverlaySnapshot } from "./target-apply";

export interface GitHubDestinationReviewBinding {
  repository: GitHubRepositoryObservation;
  installation: GitHubInstallationIdentity;
  candidatePaths: readonly string[];
  preTree: readonly OverlayFile[];
  applyDigest: string;
  validationDigest: string;
  postTreeDigest: string;
  digest: string;
}

type Provenance = Pick<
  GitHubDestinationReviewBinding,
  "applyDigest" | "validationDigest" | "postTreeDigest"
>;

export const createGitHubDestinationReviewBinding = (
  input: Omit<GitHubDestinationReviewBinding, "digest">,
): GitHubDestinationReviewBinding => {
  assertExactRepositoryObservation(input.repository);
  assertExactInstallationIdentity(input.installation);
  if (
    input.installation.operation !== "resolve-existing-source" ||
    input.repository.installationIdentityDigest !== input.installation.digest
  ) {
    throw new Error("Destination review must bind its source-read installation observation.");
  }
  const candidatePaths = [...new Set(input.candidatePaths)].toSorted(compareOverlayPaths);
  if (
    candidatePaths.some(
      (path) => !safeSourcePath(path) || path.includes("\0") || path.split("/").includes(""),
    )
  ) {
    throw new Error("Destination review contains an invalid candidate path.");
  }
  const candidates = new Set(candidatePaths);
  const repository = createRepositoryObservation({
    defaultBranch: input.repository.defaultBranch,
    headSha: input.repository.headSha,
    headTree: input.repository.headTree,
    installationIdentityDigest: input.repository.installationIdentityDigest,
    name: input.repository.name,
    owner: input.repository.owner,
    releaseGate: {
      configured: input.repository.releaseGate.configured,
      name: input.repository.releaseGate.name,
    },
    repositoryId: input.repository.repositoryId,
    visibility: input.repository.visibility,
  });
  const installation = createGitHubInstallationIdentity({
    accountId: input.installation.accountId,
    accountLogin: input.installation.accountLogin,
    accountType: input.installation.accountType,
    installationId: input.installation.installationId,
    operation: input.installation.operation,
    repositorySelection: input.installation.repositorySelection,
    selectedRepositoryIds: input.installation.selectedRepositoryIds,
  });
  const preTree = canonicalOverlayFiles(input.preTree);
  if (
    new Set(preTree.map((file) => file.path)).size !== preTree.length ||
    preTree.some((file) => !candidates.has(file.path))
  ) {
    throw new Error("Destination preimages must uniquely belong to the candidate paths.");
  }
  const body = {
    applyDigest: input.applyDigest,
    candidatePaths,
    installation,
    postTreeDigest: input.postTreeDigest,
    preTree,
    repository,
    validationDigest: input.validationDigest,
  };
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
};

export const assertGitHubDestinationReviewBinding = (
  binding: GitHubDestinationReviewBinding,
  provenance: Provenance,
): void => {
  if (createGitHubDestinationReviewBinding(binding).digest !== binding.digest) {
    throw new Error("Destination review binding digest does not match its recorded contents.");
  }
  if (
    binding.applyDigest !== provenance.applyDigest ||
    binding.validationDigest !== provenance.validationDigest ||
    binding.postTreeDigest !== provenance.postTreeDigest
  ) {
    throw new Error("Destination review does not match the validated apply provenance.");
  }
};

export const deriveDestinationChanges = (
  binding: GitHubDestinationReviewBinding,
  observed: OverlaySnapshot,
): OverlayChange[] => {
  assertGitHubDestinationReviewBinding(binding, binding);
  const candidates = new Set(binding.candidatePaths);
  return overlayChanges(
    { files: binding.preTree, treeDigest: binding.repository.headTree },
    {
      files: observed.files.filter((file) => candidates.has(file.path)),
      treeDigest: observed.treeDigest,
    },
  );
};
