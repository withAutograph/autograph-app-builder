import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: vi.fn(() => ({ issuer: "https://app.test" })),
}));
vi.mock("@/lib/provisioning/deployment", () => ({
  getBuilderProvisioningDeploymentHandler: vi.fn(
    () => async (request: Request) => {
      const input = (await request.json()) as { operation: string };
      calls.push(
        `${new URL(request.url).searchParams.get("mode") ?? "run"}:${input.operation}`
      );
      const github = {
        status: "succeeded",
        installationId: "101",
        repositoryId: "202",
        owner: "autograph",
        name: "server-action-app",
        fullName: "autograph/server-action-app",
        url: "https://github.com/autograph/server-action-app",
        scope: { type: "user", id: "77", login: "autograph" },
        visibility: "private",
        defaultBranch: "main",
        headSha: "a".repeat(40),
        headTree: "b".repeat(40),
        starter: {
          sourceSha: "c".repeat(40),
          sourceTree: "b".repeat(40),
          archiveSha256: "d".repeat(64),
          archiveBytes: 1,
          manifestSha256: "e".repeat(64),
        },
      };
      const vercel = {
        status: "succeeded",
        installationId: "vercel-team",
        projectId: "prj_303",
        name: "server-action-app",
        dashboardUrl: "https://vercel.com/autograph/server-action-app",
        scope: { type: "team", id: "team_1", slug: "autograph" },
        framework: "nextjs",
        rootDirectory: "apps/server-action-app",
        linkedGitHubRepository: "autograph/server-action-app",
      };
      return Response.json({
        version: 1,
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        requestDigest: "f".repeat(64),
        appId: "server-action-app",
        status: "settled",
        github,
        vercel:
          input.operation === "vercel"
            ? vercel
            : { status: "skipped", code: "not_selected", retryable: false },
        updatedAt: "2026-09-10T00:00:00.000Z",
      });
    }
  ),
}));
vi.mock("@/lib/handoff/deployment", () => ({
  getBuilderHandoffDeploymentHandler: vi.fn(() => async () => {
    calls.push("handoff");
    return Response.json({
      version: 1,
      handoffId: "123e4567-e89b-42d3-a456-426614174001",
      expiresAt: "2026-09-11T00:00:00.000Z",
    });
  }),
  getBuilderHandoffPageData: vi.fn(),
}));

import { continueBuilderHandoff } from "./builder";

afterEach(() => calls.splice(0));

describe("continueBuilderHandoff", () => {
  it("reserves provisioning before creating the durable handoff", async () => {
    const result = await continueBuilderHandoff(undefined, {
      version: 1,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
      provisioningEnabled: true,
      form: {
        appName: "Server Action App",
        repository: "server-action-app",
        brief: "Build this with a durable server action.",
        privateRepository: true,
        buildDestination: "codex",
        connections: [],
        githubInstallationId: "101",
        vercelInstallationId: "vercel-team",
        modelId: "openai/gpt-5.6-sol",
      },
    });

    expect(calls).toEqual(["reserve:github", "handoff"]);
    expect(result).toMatchObject({
      status: "ready",
      handoff: { handoffId: "123e4567-e89b-42d3-a456-426614174001" },
      provisioning: {
        github: { status: "succeeded" },
        vercel: { status: "skipped" },
      },
    });
  });

  it("rejects malformed input before it reaches a deployment handler", async () => {
    const result = await continueBuilderHandoff(undefined, {
      version: 1,
      requestId: "not-a-uuid",
      creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
      provisioningEnabled: false,
      form: {
        appName: "Server Action App",
        repository: "server-action-app",
        brief: "Build this with a durable server action.",
        privateRepository: true,
        buildDestination: "codex",
        connections: [],
        modelId: "openai/gpt-5.6-sol",
      },
    } as never);

    expect(result).toEqual({ status: "error" });
    expect(calls).toEqual([]);
  });
});
