import { describe, expect, it, vi } from "vitest";

import type { GitHubProvisionResult } from "./contracts";
import { provisionVercelProject } from "./vercel-provider";

const github = {
  defaultBranch: "main",
  fullName: "withAutograph/vendor-portal",
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  installationId: "101",
  name: "vendor-portal",
  owner: "withAutograph",
  repositoryId: "202",
  scope: { id: "88", login: "withAutograph", type: "organization" },
  starter: {
    archiveBytes: 100,
    archiveSha256: "d".repeat(64),
    manifestSha256: "e".repeat(64),
    sourceSha: "c".repeat(40),
    sourceTree: "b".repeat(40),
  },
  status: "succeeded",
  url: "https://github.com/withAutograph/vendor-portal",
  visibility: "private",
} satisfies GitHubProvisionResult;

function installation(scopeType: "team" | "user") {
  return {
    active: true,
    displayName: "Autograph",
    installationId: "icfg_1",
    plan: "pro",
    scopeId: scopeType === "team" ? "team_1" : "user_1",
    scopeType,
    slug: "autograph",
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
            framework: "nextjs",
            gitRepository: {
              repo: "withAutograph/vendor-portal",
              type: "github",
            },
            name: "apps-vendor-portal",
            rootDirectory: "apps/vendor-portal",
          });
          return Response.json({ id: "prj_1" }, { status: 201 });
        }
        return created
          ? Response.json({
              framework: "nextjs",
              id: "prj_1",
              link: {
                org: "withAutograph",
                repo: "vendor-portal",
                type: "github",
              },
              name: "apps-vendor-portal",
              rootDirectory: "apps/vendor-portal",
            })
          : Response.json({}, { status: 404 });
      });
      const candidates: string[] = [];
      const absent: string[] = [];
      const result = await provisionVercelProject({
        appId: "vendor-portal",
        fetch: request,
        generateSuffix: () => "a1b2c3",
        github,
        githubSelected: true,
        installation: installation(scopeType),
        persistAbsent: async (value) => void absent.push(value),
        persistCandidate: async (value) => void candidates.push(value),
        persistedAbsentCandidates: [],
        persistedCandidates: [],
        token: "vercel-token",
      });
      expect(result).toMatchObject({
        linkedGitHubRepository: "withAutograph/vendor-portal",
        projectId: "prj_1",
        status: "succeeded",
      });
      expect(candidates[0]).toBe("apps-vendor-portal");
      expect(absent).toEqual(["apps-vendor-portal"]);
      expect(
        request.mock.calls.every(
          ([url]) => !String(url).includes("deployments")
        )
      ).toBe(true);
    }
  );

  it("skips a paired Vercel operation when GitHub did not succeed", async () => {
    const request = vi.fn<typeof fetch>();
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      github: {
        code: "provider_rejected",
        retryable: true,
        status: "failed",
      },
      githubSelected: true,
      installation: installation("team"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      token: "vercel-token",
    });
    expect(result).toEqual({
      code: "github_required",
      retryable: false,
      status: "skipped",
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
          { status: 400 }
        );
      }
      return Response.json({}, { status: 404 });
    });
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      generateSuffix: () => "a1b2c3",
      github,
      githubSelected: true,
      installation: installation("team"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      token: "vercel-token",
    });
    expect(result).toMatchObject({
      code: "provider_rejected",
      status: "failed",
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
      if (path.endsWith("/apps-vendor-portal")) {
        return Response.json({ id: "unrelated" });
      }
      return created
        ? Response.json({
            framework: "nextjs",
            id: "prj_2",
            name: "apps-vendor-portal-a1b2c3",
            rootDirectory: "apps/vendor-portal",
          })
        : Response.json({}, { status: 404 });
    });
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      generateSuffix: () => "a1b2c3",
      github: {
        code: "not_selected",
        retryable: false,
        status: "skipped",
      },
      githubSelected: false,
      installation: installation("user"),
      persistAbsent: async (value) => void absent.push(value),
      persistCandidate: async (value) => void candidates.push(value),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      token: "vercel-token",
    });
    expect(result).toMatchObject({
      name: "apps-vendor-portal-a1b2c3",
      projectId: "prj_2",
      status: "succeeded",
    });
    expect(result).not.toHaveProperty("linkedGitHubRepository");
    expect(candidates.slice(0, 2)).toEqual([
      "apps-vendor-portal",
      "apps-vendor-portal-a1b2c3",
    ]);
    expect(absent).toEqual(["apps-vendor-portal-a1b2c3"]);
  });
});
