import { describe, expect, it, vi } from "vitest";

import type { GitHubProvisionResult } from "./contracts";
import { provisionVercelProject } from "./vercel-provider";

const github = {
  status: "succeeded",
  installationId: "101",
  repositoryId: "202",
  owner: "withAutograph",
  name: "vendor-portal",
  fullName: "withAutograph/vendor-portal",
  url: "https://github.com/withAutograph/vendor-portal",
  scope: { type: "organization", id: "88", login: "withAutograph" },
  visibility: "private",
  defaultBranch: "main",
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  starter: {
    sourceSha: "c".repeat(40),
    sourceTree: "b".repeat(40),
    archiveSha256: "d".repeat(64),
    archiveBytes: 100,
    manifestSha256: "e".repeat(64),
  },
} satisfies GitHubProvisionResult;

function installation(scopeType: "team" | "user") {
  return {
    installationId: "icfg_1",
    scopeId: scopeType === "team" ? "team_1" : "user_1",
    scopeType,
    displayName: "Autograph",
    slug: "autograph",
    plan: "pro",
    active: true,
    updatedAt: new Date(),
  } as const;
}

describe("Vercel project provisioning", () => {
  it.each(["team", "user"] as const)(
    "creates and reads back one linked %s project without a deployment call",
    async (scopeType) => {
      let created = false;
      const request = vi.fn<typeof fetch>(async (url, init) => {
        const value = new URL(String(url));
        expect(value.searchParams.has("teamId")).toBe(scopeType === "team");
        expect(value.pathname).not.toContain("deployments");
        if (init?.method === "POST") {
          created = true;
          const body = JSON.parse(String(init.body));
          expect(body).toMatchObject({
            name: "apps-vendor-portal",
            framework: "nextjs",
            rootDirectory: "apps/vendor-portal",
            gitRepository: {
              type: "github",
              repo: "withAutograph/vendor-portal",
            },
          });
          return Response.json({ id: "prj_1" }, { status: 201 });
        }
        return created
          ? Response.json({
              id: "prj_1",
              name: "apps-vendor-portal",
              framework: "nextjs",
              rootDirectory: "apps/vendor-portal",
              link: {
                type: "github",
                org: "withAutograph",
                repo: "vendor-portal",
              },
            })
          : Response.json({}, { status: 404 });
      });
      const candidates: string[] = [];
      const absent: string[] = [];
      const result = await provisionVercelProject({
        installation: installation(scopeType),
        token: "vercel-token",
        appId: "vendor-portal",
        github,
        githubSelected: true,
        persistedCandidates: [],
        persistedAbsentCandidates: [],
        persistCandidate: async (value) => void candidates.push(value),
        persistAbsent: async (value) => void absent.push(value),
        fetch: request,
        generateSuffix: () => "a1b2c3",
      });
      expect(result).toMatchObject({
        status: "succeeded",
        projectId: "prj_1",
        linkedGitHubRepository: "withAutograph/vendor-portal",
      });
      expect(candidates[0]).toBe("apps-vendor-portal");
      expect(absent).toEqual(["apps-vendor-portal"]);
      expect(
        request.mock.calls.every(
          ([url]) => !String(url).includes("deployments"),
        ),
      ).toBe(true);
    },
  );

  it("skips a paired Vercel operation when GitHub did not succeed", async () => {
    const request = vi.fn<typeof fetch>();
    const result = await provisionVercelProject({
      installation: installation("team"),
      token: "vercel-token",
      appId: "vendor-portal",
      github: {
        status: "failed",
        code: "provider_rejected",
        retryable: true,
      },
      githubSelected: true,
      persistedCandidates: [],
      persistedAbsentCandidates: [],
      persistCandidate: vi.fn(),
      persistAbsent: vi.fn(),
      fetch: request,
    });
    expect(result).toEqual({
      status: "skipped",
      code: "github_required",
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports Git-access rejection without creating an unlinked fallback", async () => {
    const bodies: unknown[] = [];
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json(
          { error: { code: "repo_not_found" } },
          { status: 400 },
        );
      }
      return Response.json({}, { status: 404 });
    });
    const result = await provisionVercelProject({
      installation: installation("team"),
      token: "vercel-token",
      appId: "vendor-portal",
      github,
      githubSelected: true,
      persistedCandidates: [],
      persistedAbsentCandidates: [],
      persistCandidate: vi.fn(),
      persistAbsent: vi.fn(),
      fetch: request,
      generateSuffix: () => "a1b2c3",
    });
    expect(result).toMatchObject({
      status: "failed",
      code: "provider_rejected",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("gitRepository");
  });

  it("creates a standalone Vercel-only project after a persisted name collision", async () => {
    const candidates: string[] = [];
    const absent: string[] = [];
    let created = false;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.name).toBe("apps-vendor-portal-a1b2c3");
        expect(body).not.toHaveProperty("gitRepository");
        created = true;
        return Response.json({ id: "prj_2" }, { status: 201 });
      }
      if (path.endsWith("/apps-vendor-portal"))
        return Response.json({ id: "unrelated" });
      return created
        ? Response.json({
            id: "prj_2",
            name: "apps-vendor-portal-a1b2c3",
            framework: "nextjs",
            rootDirectory: "apps/vendor-portal",
          })
        : Response.json({}, { status: 404 });
    });
    const result = await provisionVercelProject({
      installation: installation("user"),
      token: "vercel-token",
      appId: "vendor-portal",
      github: {
        status: "skipped",
        code: "not_selected",
        retryable: false,
      },
      githubSelected: false,
      persistedCandidates: [],
      persistedAbsentCandidates: [],
      persistCandidate: async (value) => void candidates.push(value),
      persistAbsent: async (value) => void absent.push(value),
      fetch: request,
      generateSuffix: () => "a1b2c3",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      projectId: "prj_2",
      name: "apps-vendor-portal-a1b2c3",
    });
    expect(result).not.toHaveProperty("linkedGitHubRepository");
    expect(candidates.slice(0, 2)).toEqual([
      "apps-vendor-portal",
      "apps-vendor-portal-a1b2c3",
    ]);
    expect(absent).toEqual(["apps-vendor-portal-a1b2c3"]);
  });
});
