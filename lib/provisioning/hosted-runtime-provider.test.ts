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
const runtimeId = "builder_runtime_1";
const ownerComment = `App Builder runtime ${runtimeId}`;
const ownedApp = {
  comment: ownerComment,
  gitBranch: target.branch,
  id: "env_app",
  key: "SPEND_REVIEW_DATABASE_URL",
  target: ["preview"],
  value: "restricted-app-value",
};
const ownedAuth = {
  ...ownedApp,
  id: "env_auth",
  key: "PLATFORM_AUTH_DATABASE_URL",
  value: "restricted-auth-value",
};

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
      if (url.pathname === "/v1/storage/stores") {
        return Response.json({
          stores: [
            {
              id: "store_neon",
              product: { integrationConfigurationId: "icfg_neon", slug: "neon" },
              projectsMetadata: [{ projectId: target.projectId }],
              status: "available",
              type: "integration",
            },
          ],
        });
      }
      if (url.pathname === "/v1/storage/stores/store_neon") {
        return Response.json({
          externalResourceId: "neon_project",
          id: "store_neon",
          ownerId: target.scopeId,
          product: { integrationConfigurationId: "icfg_neon", slug: "neon" },
          projectsMetadata: [{ projectId: target.projectId }],
          secrets: [{ name: "POSTGRES_PASSWORD", value: "must-not-escape" }],
          status: "available",
          type: "integration",
        });
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
    expect(cluster.marketplaceResource).toEqual({
      neonProjectId: "neon_project",
      resourceId: "store_neon",
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
    expect(request).toHaveBeenCalledTimes(5);
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

  it.each([
    { ...ownedApp, comment: null },
    { ...ownedApp, comment: "App Builder runtime another_runtime" },
    { ...ownedApp, configurationId: "icfg_native" },
    { ...ownedApp, target: ["preview", "production"] },
  ])("rejects an unowned or integration-owned binding before any write", async (variable) => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async () => Response.json({ envs: [variable] }));
    const provider = createHostedRuntimeVercelProvider({ credential, fetch: request, target });
    await expect(
      provider.assertEnvironmentAvailability([ownedApp.key], runtimeId),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    await expect(
      provider.bindEnvironment({ [ownedApp.key]: "new-value" }, { runtimeId }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("rejects duplicate branch bindings before writing or deleting", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ envs: [ownedApp, { ...ownedApp, id: "env_duplicate" }] }),
    );
    const provider = createHostedRuntimeVercelProvider({ credential, fetch: request, target });
    await expect(
      provider.bindEnvironment({ [ownedApp.key]: ownedApp.value }, { runtimeId }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    await expect(
      provider.removeEnvironmentBindings({ [ownedApp.key]: ownedApp.value }, { runtimeId }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("updates and reads back bindings owned by the same runtime", async () => {
    const environment = { ...ownedApp };
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource, options) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      expect(url.searchParams.get("teamId")).toBe(target.scopeId);
      if (options?.method === "POST") {
        expect(url.searchParams.get("upsert")).toBe("true");
        const [written] = z
          .array(z.object({ comment: z.string(), key: z.string(), value: z.string() }))
          .parse(JSON.parse(z.string().parse(options.body)));
        expect(written).toEqual({ comment: ownerComment, key: ownedApp.key, value: "updated" });
        environment.value = written?.value ?? "";
        return Response.json({ created: [environment], failed: [] });
      }
      return Response.json(
        url.pathname.endsWith(`/env/${environment.id}`) ? environment : { envs: [environment] },
      );
    });
    const provider = createHostedRuntimeVercelProvider({ credential, fetch: request, target });
    await provider.assertEnvironmentAvailability([ownedApp.key], runtimeId);
    expect(await provider.bindEnvironment({ [ownedApp.key]: "updated" }, { runtimeId })).toEqual([
      ownedApp.key,
    ]);
    expect(environment.value).toBe("updated");
  });

  it("does not upsert a key claimed by another runtime after the availability read", async () => {
    const foreign = { ...ownedApp, comment: "App Builder runtime another_runtime" };
    let observed: (typeof foreign)[] = [];
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource, options) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      if (options?.method === "POST") {
        expect(url.searchParams.get("upsert")).toBe("false");
        observed = [foreign];
        return Response.json({ created: [], failed: [{ error: { code: "ENV_ALREADY_EXISTS" } }] });
      }
      return Response.json(
        url.pathname.endsWith(`/env/${foreign.id}`) ? foreign : { envs: observed },
      );
    });
    await expect(
      createHostedRuntimeVercelProvider({ credential, fetch: request, target }).bindEnvironment(
        { [ownedApp.key]: "new-value" },
        { runtimeId },
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(observed).toEqual([foreign]);
  });

  it("protects native integration values even when the legacy binding API is used", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async () => Response.json({ envs: [native] }));
    await expect(
      createHostedRuntimeVercelProvider({ credential, fetch: request, target }).bindEnvironment({
        DATABASE_URL_UNPOOLED: "replacement",
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each([
    { ...ownedAuth, value: "changed-outside-builder" },
    { ...ownedAuth, comment: "App Builder runtime another_runtime" },
    { ...ownedAuth, configurationId: "icfg_native" },
    { ...ownedAuth, gitBranch: "another-branch" },
  ])("verifies every decrypted cleanup binding before the first delete", async (changed) => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      if (url.pathname.endsWith(`/env/${ownedAuth.id}`)) {
        return Response.json(changed);
      }
      if (url.pathname.endsWith(`/env/${ownedApp.id}`)) {
        return Response.json(ownedApp);
      }
      return Response.json({ envs: [ownedApp, ownedAuth] });
    });
    await expect(
      createHostedRuntimeVercelProvider({
        credential,
        fetch: request,
        target,
      }).removeEnvironmentBindings(
        { [ownedApp.key]: ownedApp.value, [ownedAuth.key]: ownedAuth.value },
        { runtimeId },
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("retries partial cleanup and preserves native, unknown, global and Production bindings", async () => {
    const preserved = [
      { ...ownedApp, comment: "operator", id: "env_unknown", key: "UNKNOWN_DATABASE_URL" },
      { ...native, value: clusterUrl },
      { ...ownedApp, gitBranch: null, id: "env_global" },
      { ...ownedApp, id: "env_production", target: ["production"] },
      { ...ownedApp, gitBranch: "another-branch", id: "env_other_branch" },
    ];
    let observed = [...preserved, ownedApp, ownedAuth];
    let failAuthDeletion = true;
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource, options) => {
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      expect(url.searchParams.get("teamId")).toBe(target.scopeId);
      if (options?.method === "DELETE") {
        expect(url.pathname).toMatch(/^\/v9\/projects\/prj_services\/env\/(?:env_app|env_auth)$/u);
        if (url.pathname.endsWith(`/env/${ownedAuth.id}`) && failAuthDeletion) {
          failAuthDeletion = false;
          return Response.json({}, { status: 503 });
        }
        observed = observed.filter(
          (environment) => !url.pathname.endsWith(`/env/${environment.id}`),
        );
        return Response.json([]);
      }
      const selected = observed.find((environment) =>
        url.pathname.endsWith(`/env/${environment.id}`),
      );
      if (selected !== undefined) {
        return Response.json(selected);
      }
      expect(url.pathname).toBe("/v10/projects/prj_services/env");
      expect(url.searchParams.get("gitBranch")).toBe(target.branch);
      return Response.json({ envs: observed });
    });
    const provider = createHostedRuntimeVercelProvider({ credential, fetch: request, target });
    const values = { [ownedApp.key]: ownedApp.value, [ownedAuth.key]: ownedAuth.value };
    await expect(provider.removeEnvironmentBindings(values, { runtimeId })).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(observed).toEqual([...preserved, ownedAuth]);
    expect(await provider.removeEnvironmentBindings(values, { runtimeId })).toEqual(
      Object.keys(values),
    );
    expect(observed).toEqual(preserved);
    expect(await provider.removeEnvironmentBindings(values, { runtimeId })).toEqual(
      Object.keys(values),
    );
    expect(observed).toEqual(preserved);
    expect(
      request.mock.calls.every(([, options]) => ["GET", "DELETE"].includes(options?.method ?? "")),
    ).toBe(true);
  });

  it.each([200, 404])("requires actual absence after a %s deletion response", async (status) => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning provider fixture.
    const request = vi.fn<typeof fetch>(async (resource, options) => {
      if (options?.method === "DELETE") {
        return Response.json({}, { status });
      }
      const url = new URL(resource instanceof Request ? resource.url : resource.toString());
      return Response.json(
        url.pathname.endsWith(`/env/${ownedApp.id}`) ? ownedApp : { envs: [ownedApp] },
      );
    });
    await expect(
      createHostedRuntimeVercelProvider({
        credential,
        fetch: request,
        target,
      }).removeEnvironmentBindings({ [ownedApp.key]: ownedApp.value }, { runtimeId }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(request.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(
      1,
    );
  });
});
