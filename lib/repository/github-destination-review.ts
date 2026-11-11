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
import { frameworkVersionsSchema } from "./framework-upgrade";
import type { FrameworkVersions } from "./framework-upgrade";

export interface FirstAppRegistration {
  appId: string;
  paths: readonly string[];
  frameworkUpgrade?: FrameworkVersions;
}

export interface GitHubDestinationReviewBinding {
  repository: GitHubRepositoryObservation;
  installation: GitHubInstallationIdentity;
  candidatePaths: readonly string[];
  preTree: readonly OverlayFile[];
  applyDigest: string;
  validationDigest: string;
  postTreeDigest: string;
  firstAppRegistration?: FirstAppRegistration;
  digest: string;
}

export const firstAppRegistrationPaths = (
  binding: GitHubDestinationReviewBinding | undefined,
  appId: string,
): readonly string[] => {
  const registration = binding?.firstAppRegistration;
  if (registration === undefined) {
    return [];
  }
  if (registration.appId !== appId) {
    throw new Error("The first publication review belongs to another app.");
  }
  return registration.paths;
};

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
  const registration = input.firstAppRegistration;
  const registrationPaths = new Set(registration?.paths);
  if (registration !== undefined) {
    const appRoot = `apps/${registration.appId}/`;
    const allowed = new Set(["package.json", "microfrontends.json", "bun.lock"]);
    const scoped = [
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(registration.appId),
      candidates.has(`${appRoot}package.json`),
      registrationPaths.has("microfrontends.json"),
      registrationPaths.size === registration.paths.length,
      registration.paths.every((path) => allowed.has(path) && candidates.has(path)),
      candidatePaths.every((path) => path.startsWith(appRoot) || registrationPaths.has(path)),
    ].every(Boolean);
    if (!scoped) {
      throw new Error(
        "First publication review must contain only the new app and its registration.",
      );
    }
  }
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
  if (registration !== undefined && preTree.some(({ path }) => !registrationPaths.has(path))) {
    throw new Error("The app already has files on the first publication destination.");
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
  if (registration === undefined) {
    return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  }
  const firstAppRegistration: FirstAppRegistration = {
    appId: registration.appId,
    paths: [...registration.paths].toSorted(compareOverlayPaths),
  };
  if (registration.frameworkUpgrade !== undefined) {
    firstAppRegistration.frameworkUpgrade = frameworkVersionsSchema.parse(
      registration.frameworkUpgrade,
    );
  }
  const scoped = { ...body, firstAppRegistration };
  return { ...scoped, digest: createHash("sha256").update(JSON.stringify(scoped)).digest("hex") };
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
