import type { withSourceUploadAuthority } from "@/lib/handoff/source-upload-deployment";
import { readAuthenticatedSourceUploadContext } from "@/lib/handoff/source-upload-deployment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { continueBuilderHandoff, continueHandoffProvisioning } from "./builder";
import { getAuthenticatedBuilderDraftContext } from "@/lib/builder-drafts/deployment";
import {
  getBuilderHandoffDeploymentHandler,
  getBuilderHandoffPageData,
} from "@/lib/handoff/deployment";

const providerInputs = vi.hoisted(() => [] as { deploymentAccess?: string; operation: string }[]);
const sourceRead = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => [] as string[]);
const drafts = vi.hoisted(() => ({ archive: vi.fn(), read: vi.fn() }));
const draftId = "123e4567-e89b-42d3-a456-426614174003";
const storedForm = {
  appName: "Server Action App",
  brief: "Build this with a durable server action.",
  buildDestination: "codex",
  connections: [],
  githubInstallationId: "101",
  modelId: "openai/gpt-5.6-sol",
  privateRepository: true,
  repository: "server-action-app",
  vercelInstallationId: "vercel-team",
};
const input = {
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  draftCheckpoint: { draftId, revision: 4 },
  provisioningEnabled: true,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  version: 1 as const,
};

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/handoff/source-upload-deployment dependency used by this test.
vi.mock("@/lib/handoff/source-upload-deployment", async (importOriginal) => {
  const actual = await importOriginal<{
    readAuthenticatedSourceUploadContext: typeof readAuthenticatedSourceUploadContext;
    withSourceUploadAuthority: typeof withSourceUploadAuthority;
  }>();
  return { ...actual, readAuthenticatedSourceUploadContext: vi.fn() };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/builder-drafts/deployment dependency used by this test.
vi.mock("@/lib/builder-drafts/deployment", () => ({
  getAuthenticatedBuilderDraftContext: vi.fn(),
}));
beforeEach(() => {
  providerInputs.length = 0;
  vi.mocked(getAuthenticatedBuilderDraftContext).mockResolvedValue({
    authority: {
      audience: "https://app.test/mcp",
      issuer: "https://app.test",
      ownerUserId: "user",
      workspaceId: "workspace",
    },
    drafts,
  } as never);
  drafts.read.mockResolvedValue({
    draftId,
    record: { draft: { form: storedForm }, version: 1 },
    revision: 4,
    status: "active",
  });
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  drafts.archive.mockImplementation(async () => {
    calls.push("archive");
    return true;
  });
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled next/cache dependency used by this test.
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled next/headers dependency used by this test.
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/auth/preview-oauth-runtime dependency used by this test.
vi.mock("@/lib/auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: vi.fn(() => ({ issuer: "https://app.test" })),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/provisioning/deployment dependency used by this test.
vi.mock("@/lib/provisioning/deployment", () => ({
  getBuilderProvisioningDeploymentHandler: vi.fn(() => async (request: Request) => {
    const requestInput = (await request.json()) as { deploymentAccess?: string; operation: string };
    providerInputs.push(requestInput);
    calls.push(
      `${new URL(request.url).searchParams.get("mode") ?? "run"}:${requestInput.operation}`,
    );
    const github = {
      defaultBranch: "main",
      fullName: "autograph/server-action-app",
      headSha: "a".repeat(40),
      headTree: "b".repeat(40),
      installationId: "101",
      name: "server-action-app",
      owner: "autograph",
      repositoryId: "202",
      scope: { id: "77", login: "autograph", type: "user" },
      starter: {
        archiveBytes: 1,
        archiveSha256: "d".repeat(64),
        manifestSha256: "e".repeat(64),
        sourceSha: "c".repeat(40),
        sourceTree: "b".repeat(40),
      },
      status: "succeeded",
      url: "https://github.com/autograph/server-action-app",
      visibility: "private",
    };
    const vercel = {
      dashboardUrl: "https://vercel.com/autograph/server-action-app",
      framework: "nextjs",
      installationId: "vercel-team",
      linkedGitHubRepository: "autograph/server-action-app",
      name: "server-action-app",
      projectId: "prj_303",
      rootDirectory: "apps/server-action-app",
      scope: { id: "team_1", slug: "autograph", type: "team" },
      status: "succeeded",
    };
    return Response.json({
      appId: "server-action-app",
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
      ...(requestInput.deploymentAccess === undefined
        ? {}
        : { deploymentAccess: requestInput.deploymentAccess }),
      github,
      requestDigest: "f".repeat(64),
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      status: "settled",
      updatedAt: "2026-09-10T00:00:00.000Z",
      vercel:
        requestInput.operation === "vercel"
          ? vercel
          : { code: "not_selected", retryable: false, status: "skipped" },
      version: 1,
    });
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/handoff/deployment dependency used by this test.
vi.mock("@/lib/handoff/deployment", () => ({
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  getBuilderHandoffDeploymentHandler: vi.fn(() => async () => {
    calls.push("handoff");
    return Response.json({
      expiresAt: "2026-09-11T00:00:00.000Z",
      handoffId: "123e4567-e89b-42d3-a456-426614174001",
      version: 1,
    });
  }),
  getBuilderHandoffPageData: vi.fn(),
}));

afterEach(() => {
  calls.splice(0);
  vi.clearAllMocks();
});

describe("continueBuilderHandoff", () => {
  it("verifies uploaded ownership before provisioning and preserves app ID independently of display name", async () => {
    const reference = {
      kind: "application-source-candidate-v1",
      uploadId: "123e4567-e89b-42d3-a456-426614174099",
      appId: "supplier-spend",
      manifestDigest: "a".repeat(64),
    };
    drafts.read.mockResolvedValueOnce({
      draftId,
      revision: 4,
      record: {
        draft: {
          form: { ...storedForm, appName: "Different display name", sourceCandidate: reference },
        },
      },
    });
    const current = await getAuthenticatedBuilderDraftContext({
      environment: process.env,
      headers: new Headers(),
    });
    if (current === undefined) {
      throw new Error("Expected signed-in draft context");
    }
    sourceRead.mockResolvedValue({ manifest: { appId: "supplier-spend" } });
    vi.mocked(readAuthenticatedSourceUploadContext).mockResolvedValue({
      authority: current.authority,
      store: { readCompleted: sourceRead },
    } as never);
    expect(await continueBuilderHandoff(undefined, input)).toMatchObject({ status: "ready" });
    expect(sourceRead).toHaveBeenCalledWith(expect.objectContaining({ reference }));
    expect(providerInputs[0]).toMatchObject({ appName: "supplier-spend" });
  });
  it("denies an incomplete or foreign source before any provider reservation", async () => {
    const reference = {
      kind: "application-source-candidate-v1",
      uploadId: "123e4567-e89b-42d3-a456-426614174099",
      appId: "supplier-spend",
      manifestDigest: "a".repeat(64),
    };
    drafts.read.mockResolvedValueOnce({
      draftId,
      revision: 4,
      record: { draft: { form: { ...storedForm, sourceCandidate: reference } } },
    });
    vi.mocked(readAuthenticatedSourceUploadContext).mockResolvedValue(globalThis.undefined);
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });
  it("accepts only an opaque checkpoint, never a second client form payload", async () => {
    expect(
      await continueBuilderHandoff(undefined, { ...input, form: storedForm } as never),
    ).toEqual({ status: "error" });
    expect(drafts.read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("reserves provisioning before creating the durable handoff", async () => {
    const result = await continueBuilderHandoff(undefined, input);

    expect(calls).toEqual(["reserve:github", "handoff", "archive"]);
    expect(drafts.read).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user", workspaceId: "workspace" }),
      draftId,
    );
    expect(drafts.archive).toHaveBeenCalledWith(expect.any(Object), draftId, 4);
    expect(result).toMatchObject({
      handoff: { handoffId: "123e4567-e89b-42d3-a456-426614174001" },
      provisioning: {
        github: { status: "succeeded" },
        vercel: { status: "skipped" },
      },
      status: "ready",
    });
  });

  it("rejects a stale checkpoint before creating provider resources or a handoff", async () => {
    expect(
      await continueBuilderHandoff(undefined, {
        ...input,
        draftCheckpoint: { draftId, revision: 3 },
      }),
    ).toEqual({ status: "error" });
    expect(calls).toEqual([]);
    expect(drafts.archive).not.toHaveBeenCalled();
  });

  it("rejects missing tenant authority before reading a draft", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Exercise missing tenant authority.
    vi.mocked(getAuthenticatedBuilderDraftContext).mockResolvedValueOnce(undefined);
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(drafts.read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("rejects an inaccessible draft before provider work", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Exercise a missing or inaccessible draft.
    drafts.read.mockResolvedValueOnce(undefined);
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });

  it("retains the draft when durable handoff creation fails", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    vi.mocked(getBuilderHandoffDeploymentHandler).mockReturnValueOnce(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    expect(await continueBuilderHandoff(undefined, input)).toEqual({ status: "error" });
    expect(drafts.archive).not.toHaveBeenCalled();
  });

  it("preserves a newer draft when conditional archival loses to another save", async () => {
    drafts.archive.mockResolvedValueOnce(false);
    expect(await continueBuilderHandoff(undefined, input)).toMatchObject({ status: "ready" });
    expect(drafts.archive).toHaveBeenCalledWith(expect.any(Object), draftId, 4);
  });

  it("rejects malformed input before it reaches a deployment handler", async () => {
    const result = await continueBuilderHandoff(undefined, {
      creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
      form: {
        appName: "Server Action App",
        brief: "Build this with a durable server action.",
        buildDestination: "codex",
        connections: [],
        modelId: "openai/gpt-5.6-sol",
        privateRepository: true,
        repository: "server-action-app",
      },
      provisioningEnabled: false,
      requestId: "not-a-uuid",
      version: 1,
    } as never);

    expect(result).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });
});

describe("saved provisioning access policy", () => {
  it.each([undefined, "public-app"] as const)(
    "preserves %s through handoff continuation",
    async (deploymentAccess) => {
      vi.mocked(getBuilderHandoffPageData).mockResolvedValueOnce({
        intent: {
          appName: storedForm.appName,
          providers: { vercelInstallationId: storedForm.vercelInstallationId },
          provisioningRequestId: input.requestId,
          provisioning: deploymentAccess === undefined ? {} : { deploymentAccess },
          repository: { requestedName: storedForm.repository, private: true },
        },
      } as never);
      expect(
        await continueHandoffProvisioning(undefined, {
          handoffId: "123e4567-e89b-42d3-a456-426614174001",
        }),
      ).toEqual({ status: "updated" });
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.deploymentAccess).toBe(deploymentAccess);
    },
  );
  it("reserves new web projects with public app access", async () => {
    expect(await continueBuilderHandoff(undefined, input)).toMatchObject({ status: "ready" });
    expect(providerInputs[0]?.deploymentAccess).toBe("public-app");
  });
});
