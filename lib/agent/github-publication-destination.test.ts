/* oxlint-disable eslint/require-await -- Asynchronous owner/access ports preserve production semantics. */
import { beforeEach, expect, it, vi } from "vitest";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { recordRepositoryAccessReceipt } from "./repository-access-state";
import { createPublicationTargetResolver } from "./github-publication-destination";

const owned = { repository: "owner/app", repositoryId: "123", selectedInstallationId: "456" };
const ctx = { callId: "review", session: { id: "saved", auth: {} } };
const repository = {
  version: 2 as const,
  repositoryId: "123",
  owner: "owner",
  name: "app",
  visibility: "private" as const,
  defaultBranch: "main",
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  installationIdentityDigest: "c".repeat(64),
  releaseGate: { name: "REPOSITORY_RELEASE_ENABLED" as const, configured: false },
  digest: "d".repeat(64),
};
const source: ImmutableGitHubSourceReceipt = {
  version: 2,
  repository,
  resolvedRef: "refs/heads/main",
  resolvedSha: repository.headSha,
  resolvedTree: repository.headTree,
  installationIdentityDigest: repository.installationIdentityDigest,
  resolvedByCallId: "acquire",
  digest: "e".repeat(64),
};
const access = (installationId: string) => {
  const observed = {
    status: "ready" as const,
    accessDigest: "f".repeat(64),
    repository: { ...repository, archived: false as const, repositoryVariableNames: [] },
    scope: { accountLogin: "owner", accountType: "Organization" as const, installationId },
  };
  return {
    kind: "ready" as const,
    access: observed,
    receipt: recordRepositoryAccessReceipt({
      current: undefined,
      sessionId: "saved",
      confirmedByCallId: "review",
      access: observed,
    }),
  };
};
const request = {
  ctx,
  appId: "app",
  sourceKind: "existing-repository" as const,
  githubSource: source,
};
const readOwned =
  vi.fn<
    NonNullable<
      Parameters<typeof createPublicationTargetResolver<typeof ctx>>[0]["readOwnedDestination"]
    >
  >();
const resolveAccess =
  vi.fn<Parameters<typeof createPublicationTargetResolver<typeof ctx>>[0]["resolveAccess"]>();
const resolvePublicationTargetForTool = createPublicationTargetResolver({
  readOwnedDestination: readOwned,
  resolveAccess,
});
beforeEach(() => {
  vi.resetAllMocks();
  readOwned.mockResolvedValue(owned);
  resolveAccess.mockResolvedValue(access("456"));
});
it("rechecks normal access and carries the saved installation through existing-app review", async () => {
  expect(await resolvePublicationTargetForTool(request)).toEqual({
    kind: "ready",
    target: {
      destination: {
        defaultBranch: "main",
        installationId: "456",
        name: "app",
        owner: "owner",
        repositoryId: "123",
      },
    },
  });
  expect(resolveAccess).toHaveBeenCalledWith(
    owned,
    ctx,
  );
  expect(readOwned).toHaveBeenCalledTimes(2);
  expect(request.githubSource).toBe(source);
});
it("denies a same-repository revision observed through a different installation", async () => {
  resolveAccess.mockResolvedValue(access("999"));
  await expect(resolvePublicationTargetForTool(request)).rejects.toThrow("destination changed");
});
it("denies canonical destination drift during revision access readback", async () => {
  readOwned
    .mockResolvedValueOnce(owned)
    .mockResolvedValueOnce({ ...owned, selectedInstallationId: "999" });
  await expect(resolvePublicationTargetForTool(request)).rejects.toThrow("destination changed");
});
it("retains the ordinary acquired source path for apps without a normal destination", async () => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit absence preserves the existing acquired-source flow.
  readOwned.mockResolvedValue(undefined);
  expect(await resolvePublicationTargetForTool(request)).toEqual({
    kind: "ready",
    target: { githubSource: source },
  });
  expect(resolveAccess).not.toHaveBeenCalled();
});
