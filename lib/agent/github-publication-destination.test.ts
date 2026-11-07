/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only terminal repository-access ports are mocked; the actual source/destination selector and ownership checks run against a bounded context fixture. */
/* oxlint-disable eslint/require-await -- Asynchronous owner/access ports preserve production semantics. */
import type { ToolContext } from "eve/tools";
import { beforeEach, expect, it, vi } from "vitest";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { recordRepositoryAccessReceipt } from "./repository-access-state";
import { resolvePublicationTargetForTool } from "./github-publication-destination";
import { readBuilderPublicationDestinationForTool } from "./builder-publication-destination";
import { resolveRepositoryAccessForTool } from "./repository-access-tool";

vi.mock("./builder-publication-destination", () => ({
  readBuilderPublicationDestinationForTool: vi.fn(),
}));
vi.mock("./repository-access-tool", () => ({ resolveRepositoryAccessForTool: vi.fn() }));
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: vi.fn(),
}));
const owned = { repository: "owner/app", repositoryId: "123", selectedInstallationId: "456" };
// SAFETY: Only callId and this exact session/auth projection are consumed; repository/provider effect ports are unavailable in this fixture.
const ctx = { callId: "review", session: { auth: {}, id: "saved" } } as unknown as ToolContext;
const repository = {
  defaultBranch: "main",
  digest: "d".repeat(64),
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  installationIdentityDigest: "c".repeat(64),
  name: "app",
  owner: "owner",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" as const },
  repositoryId: "123",
  version: 2 as const,
  visibility: "private" as const,
};
const source: ImmutableGitHubSourceReceipt = {
  digest: "e".repeat(64),
  installationIdentityDigest: repository.installationIdentityDigest,
  repository,
  resolvedByCallId: "acquire",
  resolvedRef: "refs/heads/main",
  resolvedSha: repository.headSha,
  resolvedTree: repository.headTree,
  version: 2,
};
const access = (installationId: string) => ({
  access: {
    accessDigest: "f".repeat(64),
    repository: { ...repository, archived: false as const, repositoryVariableNames: [] },
    scope: { accountLogin: "owner", accountType: "Organization" as const, installationId },
    status: "ready" as const,
  },
  kind: "ready" as const,
  receipt: recordRepositoryAccessReceipt({
    access: {
      accessDigest: "f".repeat(64),
      repository: { ...repository, archived: false, repositoryVariableNames: [] },
      scope: { accountLogin: "owner", accountType: "Organization", installationId },
      status: "ready",
    },
    confirmedByCallId: "review",
    current: undefined,
    sessionId: "saved",
  }),
});
const request = {
  appId: "app",
  ctx,
  githubSource: source,
  sourceKind: "existing-repository" as const,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
    destination: owned,
  });
  vi.mocked(resolveRepositoryAccessForTool).mockResolvedValue(access("456"));
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
  expect(resolveRepositoryAccessForTool).toHaveBeenCalledWith(
    { repository: owned.repository, selectedInstallationId: owned.selectedInstallationId },
    ctx,
    undefined,
  );
  expect(readBuilderPublicationDestinationForTool).toHaveBeenCalledTimes(2);
  expect(request.githubSource).toBe(source);
});
it("denies a same-repository revision observed through a different installation", async () => {
  vi.mocked(resolveRepositoryAccessForTool).mockResolvedValue(access("999"));
  await expect(resolvePublicationTargetForTool(request)).rejects.toThrow("destination changed");
});
it("denies canonical destination drift during revision access readback", async () => {
  vi.mocked(readBuilderPublicationDestinationForTool)
    .mockResolvedValueOnce({ publicSessionId: "public-saved", destination: owned })
    .mockResolvedValueOnce({
      publicSessionId: "public-saved",
      destination: { ...owned, selectedInstallationId: "999" },
    });
  await expect(resolvePublicationTargetForTool(request)).rejects.toThrow("destination changed");
});
it("retains the ordinary acquired source path for apps without a normal destination", async () => {
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
  });
  expect(await resolvePublicationTargetForTool(request)).toEqual({
    kind: "ready",
    target: { githubSource: source },
  });
  expect(resolveRepositoryAccessForTool).not.toHaveBeenCalled();
});

it("directs a fresh app to its saved public destination setup before any repository access", async () => {
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
  });
  expect(
    await resolvePublicationTargetForTool({ ctx, appId: "app", sourceKind: "fresh-template" }),
  ).toMatchObject({
    kind: "missing",
    guidance: {
      status: "blocked",
      code: "builder_destination_required",
      destinationPath: "/builds/public-saved/destination",
    },
  });
  expect(resolveRepositoryAccessForTool).not.toHaveBeenCalled();
});
it("keeps the explicit existing-repository selector for a fresh app with no saved destination", async () => {
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
  });
  const destination = { repository: "owner/app", selectedInstallationId: "456" };
  expect(
    await resolvePublicationTargetForTool({
      ctx,
      appId: "app",
      destination,
      sourceKind: "fresh-template",
    }),
  ).toMatchObject({ kind: "ready", target: { destination: { repositoryId: "123" } } });
  expect(resolveRepositoryAccessForTool).toHaveBeenCalledOnce();
  expect(vi.mocked(resolveRepositoryAccessForTool).mock.calls[0]?.[0]).toEqual(destination);
});
