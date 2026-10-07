import { describe, expect, it, vi } from "vitest";
import { builderHandoffIntentSchema } from "../handoff/contracts";
import type { OperatorOwnerContext, OperatorSelection } from "./hosted-operator-contract";
import { readHostedOperatorPublicGateway } from "./hosted-operator-gateway";
import type { HostedOperatorProjectDomain } from "./hosted-operator-gateway";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner-1",
  workspaceId: "workspace-1",
};
const selection: OperatorSelection = {
  appId: "vendor-onboarding",
  branch: "feature/preview",
  environment: "preview",
  projectId: "prj_1",
  sessionId: "session-1",
};
const intent = builderHandoffIntentSchema.parse({
  appId: selection.appId,
  appName: "Vendor Onboarding",
  brief: "Review vendors.",
  connections: [],
  modelId: "openai/gpt-5.6-terra",
  providers: { vercelInstallationId: "icfg_1" },
  provisioning: {
    appId: selection.appId,
    github: { code: "not_selected", retryable: false, status: "skipped" },
    requestDigest: "c".repeat(64),
    requestId: "f1184eeb-0c49-4db2-8f20-15ddfae12236",
    status: "settled",
    updatedAt: "2026-09-01T12:00:00.000Z",
    vercel: {
      dashboardUrl: "https://vercel.com/acme/apps-vendor-onboarding",
      framework: "nextjs",
      installationId: "icfg_1",
      name: "apps-vendor-onboarding",
      projectId: selection.projectId,
      rootDirectory: ".",
      scope: { id: "team_1", slug: "acme", type: "team" },
      status: "succeeded",
    },
    version: 1,
  },
  provisioningRequestDigest: "c".repeat(64),
  provisioningRequestId: "f1184eeb-0c49-4db2-8f20-15ddfae12236",
  repository: { private: true, requestedName: selection.appId },
});
const owner: OperatorOwnerContext["authority"] = authority;
const branchDomain = {
  customEnvironmentId: null,
  gitBranch: selection.branch,
  name: "vendor-preview.example.com",
  projectId: selection.projectId,
  redirect: null,
  verified: true,
};
const readyDeployment = {
  createdAt: 1_790_000_000_000,
  projectId: selection.projectId,
  readyState: "READY",
  target: null,
  uid: "dpl_1",
};

const fixture = (
  overrides: {
    domain?: HostedOperatorProjectDomain;
    additionalDomains?: HostedOperatorProjectDomain[];
    details?: {
      gitSource: { ref: string };
      id: string;
      projectId: string;
      readyState: string;
      target: string | null;
    };
    aliases?: { alias: string; uid?: string }[];
  } = {},
) => {
  const requests: URL[] = [];
  // oxlint-disable-next-line eslint/require-await, typescript/promise-function-async -- The provider fixture builds mock responses synchronously.
  const fetch = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.pathname === "/v9/projects/prj_1") {
      return Promise.resolve(Response.json({ accountId: "team_1", id: "prj_1", name: "vendor" }));
    }
    if (url.pathname === "/v9/projects/prj_1/domains") {
      return Promise.resolve(
        Response.json({
          domains: [overrides.domain ?? branchDomain, ...(overrides.additionalDomains ?? [])],
        }),
      );
    }
    if (url.pathname === "/v7/deployments") {
      return Promise.resolve(
        Response.json({
          deployments: [readyDeployment],
          pagination: { next: null },
        }),
      );
    }
    if (url.pathname === "/v13/deployments/dpl_1") {
      return Promise.resolve(
        Response.json(
          overrides.details ?? {
            gitSource: { ref: selection.branch },
            id: "dpl_1",
            projectId: selection.projectId,
            readyState: "READY",
            target: null,
          },
        ),
      );
    }
    if (url.pathname === "/v2/deployments/dpl_1/aliases") {
      return Promise.resolve(
        Response.json({
          aliases: overrides.aliases ?? [{ alias: branchDomain.name, uid: "alias-1" }],
        }),
      );
    }
    throw new Error(`Unexpected provider request: ${url.pathname}`);
  });
  // oxlint-disable-next-line eslint/require-await, typescript/promise-function-async -- The owner-bound credential fixture is in memory.
  const readVercelCredential = vi.fn(() =>
    Promise.resolve({
      binding: {
        active: true,
        displayName: "Acme",
        installationId: "icfg_1",
        plan: "pro",
        scopeId: "team_1",
        scopeType: "team" as const,
        slug: "acme",
        updatedAt: new Date(),
      },
      token: "credential-never-exposed",
    }),
  );
  return { fetch, readVercelCredential, requests };
};

const resolve = async (f: ReturnType<typeof fixture>, extra: { origin?: string } = {}) =>
  await readHostedOperatorPublicGateway({
    apiOrigin: "https://api.vercel.test",
    authority: owner,
    fetch: f.fetch,
    intent,
    readVercelCredential: f.readVercelCredential,
    selection,
    ...extra,
  });

describe("readHostedOperatorPublicGateway", () => {
  it("returns a verified exact Preview branch domain only after deployment and alias readback", async () => {
    const f = fixture();
    await expect(resolve(f, { origin: "https://model-origin.invalid" })).resolves.toEqual({
      deploymentId: "dpl_1",
      origin: "https://vendor-preview.example.com",
      status: "ready",
    });
    expect(f.readVercelCredential).toHaveBeenCalledWith({
      authority,
      installationId: "icfg_1",
    });
    expect(f.requests.map((url) => url.pathname)).toEqual([
      "/v9/projects/prj_1",
      "/v9/projects/prj_1/domains",
      "/v7/deployments",
      "/v13/deployments/dpl_1",
      "/v2/deployments/dpl_1/aliases",
    ]);
    expect(f.requests.every((url) => url.searchParams.get("teamId") === "team_1")).toBe(true);
  });

  it.each([
    ["unverified project domain", { ...branchDomain, verified: false }],
    ["another branch", { ...branchDomain, gitBranch: "main" }],
    ["another project", { ...branchDomain, projectId: "prj_other" }],
    ["custom environment", { ...branchDomain, customEnvironmentId: "env_1" }],
    ["redirected domain", { ...branchDomain, redirect: "redirect.example.com" }],
    ["private Sandbox origin", { ...branchDomain, name: "private.vercel.run" }],
    ["non-HTTPS-shaped domain value", { ...branchDomain, name: "http://attacker.example" }],
  ])("leaves %s unresolved", async (_label, domain) => {
    const f = fixture({ domain });
    await expect(resolve(f)).resolves.toMatchObject({
      predicate: "verified_preview_branch_alias",
      status: "unresolved",
    });
    expect(f.requests.some((url) => url.pathname === "/v7/deployments")).toBe(false);
  });

  it("leaves multiple exact branch domains unresolved instead of choosing one", async () => {
    const f = fixture({
      additionalDomains: [{ ...branchDomain, name: "second-preview.example.com" }],
    });
    await expect(resolve(f)).resolves.toMatchObject({
      reason: "branch_domain_ambiguous",
      status: "unresolved",
    });
  });

  it("does not accept a branch domain unless the latest exact deployment reports that alias", async () => {
    const f = fixture({ aliases: [{ alias: "another.example.com", uid: "alias-2" }] });
    await expect(resolve(f)).resolves.toMatchObject({
      reason: "deployment_alias_unavailable",
      status: "unresolved",
    });
  });

  it("rejects deployment detail that names another branch or environment", async () => {
    const f = fixture({
      details: {
        gitSource: { ref: "main" },
        id: "dpl_1",
        projectId: selection.projectId,
        readyState: "READY",
        target: null,
      },
    });
    await expect(resolve(f)).resolves.toMatchObject({
      reason: "deployment_identity_unavailable",
      status: "unresolved",
    });
  });
  it("resolves a separately configured owner-bound Gateway project while preserving the app selection", async () => {
    const f = fixture();
    const ownerFetch = f.fetch;
    const crossProjectFetch = vi.fn<typeof fetch>(async (request) => {
      const url = request instanceof Request ? new URL(request.url) : new URL(request);
      if (url.pathname === "/v9/projects/prj_gateway") {
        return Response.json({ accountId: "team_1", id: "prj_gateway", name: "gateway" });
      }
      if (url.pathname === "/v9/projects/prj_gateway/domains") {
        return Response.json({ domains: [{ ...branchDomain, projectId: "prj_gateway" }] });
      }
      if (url.pathname === "/v7/deployments") {
        return Response.json({
          deployments: [{ ...readyDeployment, projectId: "prj_gateway" }],
          pagination: { next: null },
        });
      }
      if (url.pathname === "/v13/deployments/dpl_1") {
        return Response.json({
          gitSource: { ref: selection.branch },
          id: "dpl_1",
          projectId: "prj_gateway",
          readyState: "READY",
          target: null,
        });
      }
      return await ownerFetch(request);
    });
    const result = await readHostedOperatorPublicGateway({
      apiOrigin: "https://api.vercel.test",
      authority: owner,
      fetch: crossProjectFetch,
      gatewayProjectId: "prj_gateway",
      intent,
      readVercelCredential: f.readVercelCredential,
      selection,
    });
    expect(result).toMatchObject({
      deploymentId: "dpl_1",
      origin: "https://vendor-preview.example.com",
      status: "ready",
    });
    expect(selection.projectId).toBe("prj_1");
  });
});
