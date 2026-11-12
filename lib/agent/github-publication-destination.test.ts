/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only terminal repository-access ports are mocked; the actual source/destination selector and ownership checks run against a bounded context fixture. */
/* oxlint-disable eslint/require-await -- Asynchronous owner/access ports preserve production semantics. */
import type { ToolContext } from "eve/tools";
import { beforeEach, expect, it, vi } from "vitest";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import { ARRUSTED_PRODUCTION_REPOSITORY } from "./direct-production-authorization";
import { recordRepositoryAccessReceipt } from "./repository-access-state";
import { resolvePublicationTargetForTool } from "./github-publication-destination";
import {
  readBuilderPublicationDestinationForTool,
  recordBuilderPublicationDestinationForTool,
} from "./builder-publication-destination";
import { resolveRepositoryAccessForTool } from "./repository-access-tool";

vi.mock("./builder-publication-destination", () => ({
  readBuilderPublicationDestinationForTool: vi.fn(),
  recordBuilderPublicationDestinationForTool: vi.fn(),
}));
vi.mock("./repository-access-tool", () => ({ resolveRepositoryAccessForTool: vi.fn() }));
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: vi.fn(),
}));
const owned = { repository: "owner/app", repositoryId: "123", selectedInstallationId: "456" };
// SAFETY: Only callId and this exact session/auth projection are consumed; repository/provider effect ports are unavailable in this fixture.
const ctx = { callId: "review", session: { id: "saved", auth: {} } } as unknown as ToolContext;
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
const access = (installationId: string, target = repository) => ({
  kind: "ready" as const,
  access: {
    status: "ready" as const,
    accessDigest: "f".repeat(64),
    repository: { ...target, archived: false as const, repositoryVariableNames: [] },
    scope: { accountLogin: "owner", accountType: "Organization" as const, installationId },
  },
  receipt: recordRepositoryAccessReceipt({
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    current: undefined,
    sessionId: "saved",
    confirmedByCallId: "review",
    access: {
      status: "ready",
      accessDigest: "f".repeat(64),
      repository: { ...target, archived: false, repositoryVariableNames: [] },
      scope: { accountLogin: "owner", accountType: "Organization", installationId },
    },
  }),
});
const request = {
  ctx,
  appId: "app",
  sourceKind: "existing-repository" as const,
  githubSource: source,
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
    guidance: {
      code: "builder_destination_required",
      destinationPath: "/builds/public-saved/destination",
      status: "blocked",
    },
    kind: "missing",
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
  expect(recordBuilderPublicationDestinationForTool).toHaveBeenCalledWith(
    ctx,
    "app",
    access("456").receipt,
    undefined,
  );
});

const approvedProduction = {
  repositoryFullName: ARRUSTED_PRODUCTION_REPOSITORY,
  repositoryId: "789",
  installationId: "456",
  baseBranch: "main",
} as const;
const approvedRepository = {
  ...repository,
  repositoryId: approvedProduction.repositoryId,
  owner: "withAutograph",
  name: "arrusted-development",
};
const directReview = {
  ctx,
  appId: "app",
  sourceKind: "fresh-template",
  approvedProduction,
} as const;

it("persists the exact approved destination during ordinary starter app review", async () => {
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
  });
  const readback = access(approvedProduction.installationId, approvedRepository);
  vi.mocked(resolveRepositoryAccessForTool).mockResolvedValue(readback);
  expect(await resolvePublicationTargetForTool(directReview)).toMatchObject({
    kind: "ready",
    target: { destination: { repositoryId: approvedProduction.repositoryId } },
  });
  expect(resolveRepositoryAccessForTool).toHaveBeenCalledWith(
    {
      repository: approvedProduction.repositoryFullName,
      selectedInstallationId: approvedProduction.installationId,
    },
    ctx,
    undefined,
  );
  expect(recordBuilderPublicationDestinationForTool).toHaveBeenCalledWith(
    ctx,
    directReview.appId,
    readback.receipt,
    { requireExactReadback: true },
  );
});

it("rejects a different saved or caller destination before review can request repository access", async () => {
  await expect(resolvePublicationTargetForTool(directReview)).rejects.toThrow(
    "repository and GitHub account approved for Production",
  );
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
  });
  await expect(
    resolvePublicationTargetForTool({ ...directReview, destination: owned }),
  ).rejects.toThrow("repository and GitHub account approved for Production");
  expect(resolveRepositoryAccessForTool).not.toHaveBeenCalled();
  expect(recordBuilderPublicationDestinationForTool).not.toHaveBeenCalled();
});

it("rejects a changed default branch at readback before persisting the destination", async () => {
  vi.mocked(readBuilderPublicationDestinationForTool).mockResolvedValue({
    publicSessionId: "public-saved",
  });
  vi.mocked(resolveRepositoryAccessForTool).mockResolvedValue(
    access(approvedProduction.installationId, { ...approvedRepository, defaultBranch: "other" }),
  );
  await expect(resolvePublicationTargetForTool(directReview)).rejects.toThrow(
    "verified GitHub destination changed",
  );
  expect(recordBuilderPublicationDestinationForTool).not.toHaveBeenCalled();
});
