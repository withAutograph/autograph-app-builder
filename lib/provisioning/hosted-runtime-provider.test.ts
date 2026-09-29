import { z } from "zod";

import { describe, expect, it, vi } from "vitest";

import {
  createHostedRuntimeVercelProvider,
  HostedRuntimeProviderError,
  parseNativeNeonRuntimeEndpoint,
} from "./hosted-runtime-provider";

const target = {
  appId: "spend-review",
  branch: "builder/spend-review",
  environment: "preview",
  installationId: "icfg_builder",
  projectId: "prj_services",
  scopeId: "team_owner",
  scopeType: "team",
  sessionId: "session_1",
} as const;
const credential = {
  binding: {
    active: true,
    displayName: "Owner",
    installationId: target.installationId,
    plan: "pro",
    scopeId: target.scopeId,
    scopeType: target.scopeType,
    slug: "owner",
    updatedAt: new Date(),
  },
  token: "test-token",
};
const native = {
  configurationId: "icfg_neon",
  gitBranch: target.branch,
  id: "env_native",
  key: "DATABASE_URL_UNPOOLED",
  target: ["preview"],
  type: "encrypted",
};
const guard = {
  ...native,
  configurationId: "",
  id: "env_guard",
  key: "AUTH_PRODUCTION_DATABASE_IDENTITY",
  value: "ep-production.us-east-1.aws.neon.tech/neondb",
};
const clusterUrl =
  "postgresql://installer:fixture-secret@ep-owner.us-east-1.aws.neon.tech/neondb?sslmode=require";

describe("owner-bound native Neon runtime adapter", () => {
  it("rechecks dedicated bindings with read-only calls before a consumer launches", async () => {
    const expected = { SPEND_REVIEW_DATABASE_URL: "restricted-value" };
    const environment = {
      ...native,
      id: "env_app",
      key: "SPEND_REVIEW_DATABASE_URL",
      value: "restricted-value",
    };
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      return Response.json(
        url.pathname.endsWith("/env/env_app") ? environment : { envs: [environment] },
      );
    });
    const provider = createHostedRuntimeVercelProvider({ credential, fetch: request, target });
    await provider.assertEnvironmentBindings(expected);
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    environment.value = "changed-outside-builder";
    await expect(provider.assertEnvironmentBindings(expected)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
  });
  it("uses only the selected project, exact Preview branch and native env ID", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      expect(url.searchParams.get("teamId")).toBe(target.scopeId);
      if (url.pathname.endsWith("/env/env_guard")) {
        return Response.json(guard);
      }
      if (url.pathname.endsWith("/env/env_native")) {
        return Response.json({ ...native, value: clusterUrl });
      }
      if (url.pathname.endsWith("/env")) {
        expect(url.searchParams.get("gitBranch")).toBe(target.branch);
        return Response.json({ envs: [native, guard] });
      }
      return Response.json({
        accountId: target.scopeId,
        framework: "services",
        id: target.projectId,
        rootDirectory: ".",
      });
    });
    const provider = createHostedRuntimeVercelProvider({ credential, fetch: request, target });
    await provider.assertProject();
    const cluster = await provider.readClusterCredential();
    expect(cluster.reference).toEqual({
      configurationId: "icfg_neon",
      environmentId: "env_native",
    });
    expect(new URL(cluster.clusterUrl).searchParams.get("sslmode")).toBe("verify-full");
    expect(cluster.productionDatabaseIdentity).toBe(guard.value);
    expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each([
    { ...guard, value: "ep-owner.us-east-1.aws.neon.tech/neondb" },
    { ...guard, value: "ep-owner-pooler.us-east-1.aws.neon.tech/another_database" },
  ])(
    "denies the selected Production endpoint even under another database",
    async (selectedGuard) => {
      // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
      const request = vi.fn<typeof fetch>(async (resource) => {
        const url = new URL(resource instanceof Request ? resource.url : resource.toString());
        if (url.pathname.endsWith("/env/env_guard")) {
          return Response.json(selectedGuard);
        }
        if (url.pathname.endsWith("/env/env_native")) {
          return Response.json({ ...native, value: clusterUrl });
        }
        return Response.json({ envs: [native, selectedGuard] });
      });
      await expect(
        createHostedRuntimeVercelProvider({
          credential,
          fetch: request,
          target,
        }).readClusterCredential(),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    },
  );

  it("requires the selected project's Production guard before preparing resources", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      return url.pathname.endsWith("/env/env_native")
        ? Response.json({ ...native, value: clusterUrl })
        : Response.json({ envs: [native] });
    });
    await expect(
      createHostedRuntimeVercelProvider({
        credential,
        fetch: request,
        target,
      }).readClusterCredential(),
    ).rejects.toMatchObject({ code: "connection_required" });
  });

  it("requires the Services preset at the repository root", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        accountId: target.scopeId,
        framework: "nextjs",
        id: target.projectId,
        rootDirectory: ".",
      }),
    );
    await expect(
      createHostedRuntimeVercelProvider({ credential, fetch: request, target }).assertProject(),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it.each([
    { ...native, gitBranch: null },
    { ...native, gitBranch: "another-branch" },
    { ...native, target: ["production"] },
    { ...native, configurationId: "" },
  ])(
    "rejects a fallback or unconnected installer variable before decrypting it",
    async (variable) => {
      // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
      const request = vi.fn<typeof fetch>(async () => Response.json({ envs: [variable] }));
      await expect(
        createHostedRuntimeVercelProvider({
          credential,
          fetch: request,
          target,
        }).readClusterCredential(),
      ).rejects.toMatchObject({ code: "connection_required" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("denies a revoked or mismatched owner installation before any provider request", () => {
    const request = vi.fn<typeof fetch>();
    expect(() =>
      createHostedRuntimeVercelProvider({
        credential: { ...credential, binding: { ...credential.binding, scopeId: "team_other" } },
        fetch: request,
        target,
      }),
    ).toThrow(HostedRuntimeProviderError);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "postgresql://installer:secret@ep-owner-pooler.us-east-1.aws.neon.tech/db?sslmode=require",
    "postgresql://installer:secret@localhost/db?sslmode=require",
    "postgresql://installer:secret@ep-owner.us-east-1.aws.neon.tech/db?sslmode=disable",
  ])("rejects pooled, local and unverified endpoints", (endpoint) => {
    expect(() => parseNativeNeonRuntimeEndpoint(endpoint)).toThrow(HostedRuntimeProviderError);
  });

  it("writes and reads back only named Preview branch values", async () => {
    const values = {
      PLATFORM_AUTH_DATABASE_URL: "fixture-auth-url",
      SPEND_REVIEW_DATABASE_URL: "fixture-app-url",
    };
    const observed = Object.entries(values).map(([key, value], index) => ({
      gitBranch: target.branch,
      id: `env_${index}`,
      key,
      target: ["preview"],
      value,
    }));
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      if (init?.method === "POST") {
        expect(url.searchParams.get("upsert")).toBe("true");
        const body = z
          .array(
            z.object({
              gitBranch: z.string(),
              key: z.string(),
              target: z.array(z.string()),
              type: z.string(),
            }),
          )
          .parse(JSON.parse(z.string().parse(init.body)));
        expect(body.map((entry) => entry.key)).toEqual(Object.keys(values));
        expect(
          body.every(
            (entry) =>
              entry.gitBranch === target.branch &&
              JSON.stringify(entry.target) === '["preview"]' &&
              entry.type === "encrypted",
          ),
        ).toBe(true);
        return Response.json({ created: observed, failed: [] });
      }
      const selected = observed.find((environment) =>
        url.pathname.endsWith(`/env/${environment.id}`),
      );
      return Response.json(selected ?? { envs: observed });
    });
    expect(
      await createHostedRuntimeVercelProvider({
        credential,
        fetch: request,
        target,
      }).bindEnvironment(values),
    ).toEqual(Object.keys(values));
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("treats partial writes as unfinished until secret readback agrees", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (_resource, init) =>
      init?.method === "POST"
        ? Response.json({
            failed: [{ error: { message: "a provider body may contain credentials" } }],
          })
        : Response.json({ envs: [] }),
    );
    await expect(
      createHostedRuntimeVercelProvider({ credential, fetch: request, target }).bindEnvironment({
        SPEND_REVIEW_DATABASE_URL: "fixture",
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });
});
