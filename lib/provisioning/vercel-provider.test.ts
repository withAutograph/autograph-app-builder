import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  it.each([
    ["prod_deployment_urls_and_all_previews", true, "team", "succeeded"],
    ["all", true, "team", "failed"],
    [null, true, "team", "failed"],
    ["prod_deployment_urls_and_all_previews", false, "team", "failed"],
    ["prod_deployment_urls_and_all_previews", true, "global", "failed"],
  ] as const)(
    "verifies public-app access policy %s / OIDC %s / %s before success",
    async (deploymentType, enabled, issuerMode, status) => {
      let created = false;
      const writes: unknown[] = [];
      // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
      const request = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") {
          // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture request-body coercion used by this assertion.
          writes.push(JSON.parse(String(init.body)));
          created = true;
          return Response.json({ id: "prj_public" }, { status: 201 });
        }
        return created
          ? Response.json({
              framework: "services",
              id: "prj_public",
              name: "apps-vendor-portal",
              rootDirectory: ".",
              ssoProtection: deploymentType === null ? null : { deploymentType },
              oidcTokenConfig: { enabled, issuerMode },
            })
          : Response.json({}, { status: 404 });
      });
      const result = await provisionVercelProject({
        appId: "vendor-portal",
        deploymentAccess: "public-app",
        fetch: request,
        github: { code: "not_selected", retryable: false, status: "skipped" },
        githubSelected: false,
        installation: installation("team"),
        persistAbsent: vi.fn(),
        persistCandidate: vi.fn(),
        persistedAbsentCandidates: [],
        persistedCandidates: [],
        token: "vercel-token",
      });
      expect(result.status).toBe(status);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        framework: "services",
        oidcTokenConfig: { enabled: true, issuerMode: "team" },
        rootDirectory: ".",
        ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" },
      });
      expect(request.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
    },
  );

  it.each([
    [
      JSON.stringify({ error: { code: "forbidden", message: "secret" } }),
      "iad1::failure_123",
      { code: "forbidden", requestRef: "iad1::failure_123", statusCode: 403 },
    ],
    [
      JSON.stringify({ error: { code: "secret", message: "secret" }, token: "secret" }),
      "https://secret.example",
      { statusCode: 403 },
    ],
    ["not-json", "iad1::failure_123", { requestRef: "iad1::failure_123", statusCode: 403 }],
  ])("retains only allowlisted provider failure facts", async (body, requestRef, diagnostic) => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "POST") {
        return Response.json({}, { status: 404 });
      }
      return new Response(body, { status: 403, headers: { "x-vercel-id": requestRef } });
    });
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      github: { code: "not_selected", retryable: false, status: "skipped" },
      githubSelected: false,
      installation: installation("team"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      token: "secret",
    });
    expect(result).toMatchObject({
      code: "provider_permission_denied",
      providerDiagnostic: diagnostic,
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["prod_deployment_urls_and_all_previews", true, "team", "succeeded"],
    ["all", true, "team", "failed"],
    [null, true, "team", "failed"],
    ["prod_deployment_urls_and_all_previews", false, "team", "failed"],
    ["prod_deployment_urls_and_all_previews", true, "global", "failed"],
  ] as const)(
    "verifies public-app access policy %s / OIDC %s / %s before success",
    async (deploymentType, enabled, issuerMode, status) => {
      let created = false;
      const writes: unknown[] = [];
      // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
      const request = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") {
          // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture request-body coercion used by this assertion.
          writes.push(JSON.parse(String(init.body)));
          created = true;
          return Response.json({ id: "prj_public" }, { status: 201 });
        }
        return created
          ? Response.json({
              framework: "services",
              id: "prj_public",
              name: "apps-vendor-portal",
              rootDirectory: ".",
              ssoProtection: deploymentType === null ? null : { deploymentType },
              oidcTokenConfig: { enabled, issuerMode },
            })
          : Response.json({}, { status: 404 });
      });
      const result = await provisionVercelProject({
        appId: "vendor-portal",
        deploymentAccess: "public-app",
        fetch: request,
        github: { code: "not_selected", retryable: false, status: "skipped" },
        githubSelected: false,
        installation: installation("team"),
        persistAbsent: vi.fn(),
        persistCandidate: vi.fn(),
        persistedAbsentCandidates: [],
        persistedCandidates: [],
        token: "vercel-token",
      });
      expect(result.status).toBe(status);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        framework: "services",
        oidcTokenConfig: { enabled: true, issuerMode: "team" },
        rootDirectory: ".",
        ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" },
      });
      expect(request.mock.calls.every(([, init]) => init?.method !== "PATCH")).toBe(true);
    },
  );

  it.each([
    [
      { error: { code: "forbidden", message: "secret" } },
      "iad1::failure_123",
      { code: "forbidden", requestRef: "iad1::failure_123", statusCode: 403 },
    ],
    [
      { error: { code: "secret", message: "secret" }, token: "secret" },
      "https://secret.example",
      { statusCode: 403 },
    ],
    ["not-json", "iad1::failure_123", { requestRef: "iad1::failure_123", statusCode: 403 }],
  ])("retains only allowlisted provider failure facts", async (body, requestRef, diagnostic) => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "POST") {
        return Response.json({}, { status: 404 });
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This negative table deliberately supplies raw text and structured provider error bodies to the actual sanitizer.
      return typeof body === "string"
        ? new Response(body, { status: 403, headers: { "x-vercel-id": requestRef } })
        : Response.json(body, { status: 403, headers: { "x-vercel-id": requestRef } });
    });
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      github: { code: "not_selected", retryable: false, status: "skipped" },
      githubSelected: false,
      installation: installation("team"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      token: "secret",
    });
    expect(result).toMatchObject({
      code: "provider_permission_denied",
      providerDiagnostic: diagnostic,
      status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("pauses when an expired write may already have created a project", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        framework: "services",
        id: "prj_existing",
        name: "apps-vendor-portal",
        rootDirectory: ".",
      }),
    );
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      github: { code: "not_selected", retryable: false, status: "skipped" },
      githubSelected: false,
      installation: installation("user"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: ["apps-vendor-portal"],
      persistedCandidates: ["apps-vendor-portal"],
      reconcilePriorWrite: true,
      token: "vercel-token",
    });
    expect(result).toEqual({
      code: "reconciliation_uncertain",
      retryable: false,
      status: "failed",
    });
    expect(request.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("does not retry an uncertain project write after a read-only 404", async () => {
    let created = false;
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        created = true;
        return Response.json({ id: "prj_new" }, { status: 201 });
      }
      return created
        ? Response.json({
            framework: "services",
            id: "prj_new",
            name: "apps-vendor-portal",
            rootDirectory: ".",
          })
        : Response.json({}, { status: 404 });
    });
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      github: { code: "not_selected", retryable: false, status: "skipped" },
      githubSelected: false,
      installation: installation("user"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: ["apps-vendor-portal"],
      persistedCandidates: ["apps-vendor-portal"],
      reconcilePriorWrite: true,
      token: "vercel-token",
    });
    expect(result).toEqual({
      code: "reconciliation_uncertain",
      retryable: false,
      status: "failed",
    });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("preserves provider retry delay and stops on a rate limit", async () => {
    const observed: number[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "POST"
        ? Response.json(
            { error: { code: "rate_limited" } },
            { headers: { "Retry-After": "37" }, status: 429 },
          )
        : Response.json({}, { status: 404 }),
    );
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      github: { code: "not_selected", retryable: false, status: "skipped" },
      githubSelected: false,
      installation: installation("user"),
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      recordRetryAfter: (milliseconds) => {
        observed.push(milliseconds);
      },
      token: "vercel-token",
    });
    expect(result).toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
      status: "failed",
    });
    expect(observed).toEqual([37_000]);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("continues through more than five occupied names", async () => {
    const created = new Set<string>();
    let suffixNumber = 0;
    const candidates: string[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async (url, init) => {
      // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture fetch-input coercion used for routing or assertions.
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture request-body coercion used by this assertion.
        const body = z.object({ name: z.string() }).parse(JSON.parse(String(init.body)));
        created.add(body.name);
        return Response.json({ id: "prj_7" }, { status: 201 });
      }
      const name = decodeURIComponent(path.split("/").at(-1) ?? "");
      if (!created.has(name)) {
        return candidates.length <= 6
          ? Response.json({ id: "occupied" })
          : Response.json({}, { status: 404 });
      }
      return Response.json({
        framework: "services",
        id: "prj_7",
        name,
        rootDirectory: ".",
      });
    });
    const result = await provisionVercelProject({
      appId: "vendor-portal",
      fetch: request,
      generateSuffix: () => {
        suffixNumber += 1;
        return `a${String(suffixNumber).padStart(5, "0")}`;
      },
      github: { code: "not_selected", retryable: false, status: "skipped" },
      githubSelected: false,
      installation: installation("user"),
      persistAbsent: vi.fn(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      persistCandidate: async (value) => {
        candidates.push(value);
      },
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      token: "vercel-token",
    });
    expect(result.status).toBe("succeeded");
    expect(candidates).toHaveLength(7);
  });
  it.each(["team", "user"] as const)(
    "creates and reads back one linked %s project without a deployment call",
    async (scopeType) => {
      let created = false;
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const request = vi.fn<typeof fetch>(async (url, init) => {
        // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture fetch-input coercion used for routing or assertions.
        const value = new URL(String(url));
        expect(value.searchParams.has("teamId")).toBe(scopeType === "team");
        expect(value.pathname).not.toContain("deployments");
        if (init?.method === "POST") {
          created = true;
          // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture request-body coercion used by this assertion.
          const body: unknown = JSON.parse(String(init.body));
          expect(body).not.toHaveProperty("ssoProtection");
          expect(body).not.toHaveProperty("oidcTokenConfig");
          expect(body).toMatchObject({
            framework: "services",
            gitRepository: {
              repo: "withAutograph/vendor-portal",
              type: "github",
            },
            name: "apps-vendor-portal",
            rootDirectory: ".",
          });
          return Response.json({ id: "prj_1" }, { status: 201 });
        }
        return created
          ? Response.json({
              framework: "services",
              id: "prj_1",
              link: {
                org: "withAutograph",
                repo: "vendor-portal",
                type: "github",
              },
              name: "apps-vendor-portal",
              rootDirectory: ".",
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
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        persistAbsent: async (value) => {
          absent.push(value);
        },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        persistCandidate: async (value) => {
          candidates.push(value);
        },
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
      // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture fetch-input coercion used for routing or assertions.
      expect(request.mock.calls.every(([url]) => !String(url).includes("deployments"))).toBe(true);
    },
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
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture request-body coercion used by this assertion.
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ error: { code: "repo_not_found" } }, { status: 400 });
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
      code: "provider_validation_failed",
      status: "failed",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("gitRepository");
  });

  it("creates a standalone Vercel-only project after a persisted name collision", async () => {
    const candidates: string[] = [];
    const absent: string[] = [];
    let created = false;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async (url, init) => {
      // oxlint-disable-next-line typescript/no-base-to-string -- Preserve the fixture fetch-input coercion used for routing or assertions.
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        // oxlint-disable-next-line typescript/no-base-to-string, typescript/no-unsafe-assignment -- Preserve the fixture request-body coercion used by this assertion.; Preserve the existing JSON parsing boundary.
        const body = JSON.parse(String(init.body));
        // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
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
            framework: "services",
            id: "prj_2",
            name: "apps-vendor-portal-a1b2c3",
            rootDirectory: ".",
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      persistAbsent: async (value) => {
        absent.push(value);
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      persistCandidate: async (value) => {
        candidates.push(value);
      },
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
    expect(candidates.slice(0, 2)).toEqual(["apps-vendor-portal", "apps-vendor-portal-a1b2c3"]);
    expect(absent).toEqual(["apps-vendor-portal-a1b2c3"]);
  });
});
