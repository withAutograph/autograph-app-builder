/* oxlint-disable eslint/require-await -- Fixture ports preserve the asynchronous production boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryProductionConnectionReader } from "./repository-production-connections";
import type { RepositoryProductionConnectionProfile } from "./repository-production-connections";
import { repositoryProductionSecretConnectionSchema } from "./repository-production-configuration";

type Input = Parameters<typeof createRepositoryProductionConnectionReader>[0];
type Io = NonNullable<Input["io"]>;
const operator = {
  projectId: "production-operator",
  ownerId: "team",
  environment: "production" as const,
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
};
const resources: Input["resources"] = {
  neon: {
    projectId: "neon-project",
    branchId: "production-branch",
    endpointId: "ep-production",
    endpoint: "ep-production.us-east-1.aws.neon.tech",
    maintenanceDatabase: "neondb",
    maintenanceRole: "maintenance",
  },
  authOperatorRole: "auth_operator",
  authResource: {
    resourceId: "auth-resource",
    database: "auth",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
  },
};
const secrets = repositoryProductionSecretConnectionSchema.parse({
  kind: "deployment-secrets",
  maintenanceUrlEnvironment: "APP_PRODUCTION_MAINTENANCE",
  authOperatorEnvironment: "APP_PRODUCTION_AUTH_OPERATOR",
  authRuntimeEnvironment: "APP_PRODUCTION_AUTH_RUNTIME",
});
const uri = (database: string, role: string) =>
  `postgresql://${role}:private-fixture-password@${resources.neon.endpoint}/${database}?sslmode=require`;
type FixtureEnvironment = Record<
  "APP_PRODUCTION_MAINTENANCE" | "APP_PRODUCTION_AUTH_OPERATOR" | "APP_PRODUCTION_AUTH_RUNTIME",
  string | undefined
>;
const fixture = (
  connection?: RepositoryProductionConnectionProfile,
  configuredResources: Input["resources"] = resources,
) => {
  const environment: FixtureEnvironment = {
    APP_PRODUCTION_MAINTENANCE: uri("neondb", "maintenance"),
    APP_PRODUCTION_AUTH_OPERATOR: uri("auth", "auth_operator"),
    APP_PRODUCTION_AUTH_RUNTIME: uri("auth", "auth_runtime"),
  };
  const io = {
    getOidc: vi.fn<Io["getOidc"]>().mockResolvedValue("current-production-oidc"),
    verifyOidc: vi.fn<Io["verifyOidc"]>(async () => {}),
    getToken: vi.fn<Io["getToken"]>().mockResolvedValue("private-connect-token"),
    readIdentity: vi.fn<Io["readIdentity"]>(async (value) => {
      const url = new URL(value);
      return { database: url.pathname.slice(1), role: url.username };
    }),
  };
  const request = vi.fn<typeof fetch>(async (value) => {
    const url = new URL(value instanceof Request ? value.url : value);
    if (url.pathname.endsWith("/connection_uri")) {
      return Response.json({
        uri: uri(
          url.searchParams.get("database_name") ?? "",
          url.searchParams.get("role_name") ?? "",
        ),
      });
    }
    return Response.json({
      endpoint: {
        id: resources.neon.endpointId,
        project_id: resources.neon.projectId,
        branch_id: resources.neon.branchId,
        host: resources.neon.endpoint,
        type: "read_write",
      },
    });
  });
  const assertCurrent = vi.fn(async () => {});
  return {
    environment,
    io,
    request,
    assertCurrent,
    read: createRepositoryProductionConnectionReader({
      connection: connection ?? { ...secrets, operator },
      resources: configuredResources,
      environment,
      io,
      fetch: request,
      assertCurrent,
      signal: new AbortController().signal,
    }),
  };
};

describe("Production repository connection bindings", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["getOidc", "workload_oidc_acquire"],
    ["verifyOidc", "workload_oidc_verify"],
  ] as const)(
    "identifies %s failure without leaking its private exception",
    async (method, phase) => {
      const h = fixture();
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      const original = new Error("private workload token and request body");
      h.io[method].mockRejectedValue(original);
      await expect(h.read()).rejects.toBe(original);
      expect(h.io.readIdentity).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("")).toContain(`"phase":"${phase}"`);
      expect(log.mock.calls.flat().join("")).not.toContain(original.message);
    },
  );

  it("reports missing and invalid binding phases before credentials reach SQL", async () => {
    const h = fixture();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.environment.APP_PRODUCTION_AUTH_OPERATOR = undefined;
    await expect(h.read()).rejects.toThrow("repository_production_connection_binding_unavailable");
    expect(log.mock.calls.flat().join("")).toContain('"phase":"auth_operator_binding"');
    expect(log.mock.calls.flat().join("")).toContain('"code":"binding_unavailable"');
    h.environment.APP_PRODUCTION_AUTH_OPERATOR = uri("auth", "private_wrong_role");
    await expect(h.read()).rejects.toThrow("repository_production_provider_scope_mismatch");
    expect(log.mock.calls.flat().join("")).not.toContain("private_wrong_role");
    expect(h.io.readIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["maintenance", "maintenance_identity"],
    ["auth_operator", "auth_operator_identity"],
    ["auth_runtime", "auth_runtime_identity"],
  ] as const)(
    "identifies the failed %s SQL identity without connection details",
    async (role, phase) => {
      const h = fixture();
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      const original = Object.assign(new Error(uri("auth", role)), { code: "28P01" });
      h.io.readIdentity.mockImplementation(async (value) => {
        const url = new URL(value);
        if (url.username === role) {
          throw original;
        }
        return { database: url.pathname.slice(1), role: url.username };
      });
      await expect(h.read()).rejects.toThrow(/^repository_production_provider_unavailable$/u);
      const output = log.mock.calls.flat().join("");
      expect(output).toContain(`"phase":"${phase}"`);
      expect(output).toContain('"sqlState":"28P01"');
      expect(output).not.toContain("postgresql:");
      expect(output).not.toContain("private-fixture-password");
      expect(h.io.getToken).not.toHaveBeenCalled();
    },
  );

  it("keeps authorization failure authoritative even when failure logging throws", async () => {
    const h = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const original = new Error("authorization revoked");
    h.assertCurrent.mockRejectedValue(original);
    await expect(h.read()).rejects.toBe(original);
    expect(h.io.getOidc).not.toHaveBeenCalled();
    expect(h.io.readIdentity).not.toHaveBeenCalled();
  });
  it("reads exact deployment-managed credentials under current Production OIDC and verifies SQL identities", async () => {
    const h = fixture();
    const result = await h.read();
    expect(h.io.verifyOidc).toHaveBeenCalledWith("current-production-oidc", operator);
    expect(h.io.readIdentity).toHaveBeenCalledTimes(3);
    expect(new URL(result.maintenanceUrl).searchParams.get("sslmode")).toBe("verify-full");
    expect(new URL(result.authOperator).username).toBe("auth_operator");
    expect(new URL(result.authRuntime).username).toBe("auth_runtime");
    expect(h.io.getToken).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each([
    "APP_PRODUCTION_MAINTENANCE",
    "APP_PRODUCTION_AUTH_OPERATOR",
    "APP_PRODUCTION_AUTH_RUNTIME",
  ] as const)(
    "stops before database reads when %s is missing; never tries another binding",
    async (key) => {
      const h = fixture();
      h.environment[key] = undefined;
      await expect(h.read()).rejects.toThrow(
        "repository_production_connection_binding_unavailable",
      );
      expect(h.io.readIdentity).not.toHaveBeenCalled();
      expect(h.io.getToken).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each(["auth_migrator", "auth_runtime"])(
    "rejects an Auth %s credential in the operator binding before SQL or provider effects",
    async (role) => {
      const h = fixture();
      h.environment.APP_PRODUCTION_AUTH_OPERATOR = uri("auth", role);
      await expect(h.read()).rejects.toThrow("repository_production_provider_scope_mismatch");
      expect(h.io.readIdentity).not.toHaveBeenCalled();
      expect(h.io.getToken).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each(["auth_migrator", "auth_runtime", ""])(
    "rejects a profile that aliases the operator to an invalid role (%s)",
    async (authOperatorRole) => {
      const h = fixture(undefined, { ...resources, authOperatorRole });
      await expect(h.read()).rejects.toThrow("repository_production_provider_scope_mismatch");
      expect(h.io.readIdentity).not.toHaveBeenCalled();
      expect(h.io.getToken).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    uri("wrong_database", "auth_runtime"),
    uri("auth", "maintenance"),
    uri("auth", "auth_runtime").replace("ep-production.", "ep-preview."),
    uri("auth", "auth_runtime").replace("ep-production.", "ep-production-pooler."),
    uri("auth", "auth_runtime").replace("sslmode=require", "sslmode=disable"),
    `${uri("auth", "auth_runtime")}&options=unsafe`,
  ])("rejects invalid credential scope before opening any database", async (value) => {
    const h = fixture();
    h.environment.APP_PRODUCTION_AUTH_RUNTIME = value;
    await expect(h.read()).rejects.toThrow("repository_production_provider_scope_mismatch");
    expect(h.io.readIdentity).not.toHaveBeenCalled();
    expect(h.io.getToken).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("rejects incorrect SQL identity and suppresses private driver errors", async () => {
    const h = fixture();
    h.io.readIdentity.mockResolvedValue({ database: "wrong", role: "wrong" });
    await expect(h.read()).rejects.toThrow("repository_production_provider_scope_mismatch");
    h.io.readIdentity.mockRejectedValue(new Error(uri("auth", "auth_runtime")));
    await expect(h.read()).rejects.toThrow(/^repository_production_provider_unavailable$/u);
    expect(h.io.getToken).not.toHaveBeenCalled();
  });

  it("stops on missing approval or Production OIDC before credentials are used", async () => {
    const denied = fixture();
    denied.assertCurrent.mockRejectedValue(new Error("approval revoked"));
    await expect(denied.read()).rejects.toThrow("approval revoked");
    expect(denied.io.getOidc).not.toHaveBeenCalled();
    const h = fixture();
    h.io.verifyOidc.mockRejectedValue(new Error("wrong workload"));
    await expect(h.read()).rejects.toThrow("wrong workload");
    expect(h.io.readIdentity).not.toHaveBeenCalled();
    expect(h.io.getToken).not.toHaveBeenCalled();
  });

  it("retains managed Connect and reads only the configured provider endpoint", async () => {
    const h = fixture({
      connector: "neon/production",
      installationId: "production-install",
      subject: { id: "owner", issuer: "https://builder.example", type: "user" },
      operator,
    });
    const result = await h.read();
    expect(new URL(result.authOperator).username).toBe("auth_operator");
    expect(new URL(result.authRuntime).username).toBe("auth_runtime");
    expect(h.io.getToken).toHaveBeenCalledWith(
      "neon/production",
      expect.objectContaining({ installationId: "production-install" }),
      { forceRefresh: true, vercelToken: "current-production-oidc" },
    );
    expect(h.request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    const requestedRoles = h.request.mock.calls.flatMap(([value]) => {
      const url = new URL(value instanceof Request ? value.url : value);
      const role = url.searchParams.get("role_name");
      return role === null ? [] : [role];
    });
    expect(requestedRoles).toContain("auth_operator");
    expect(requestedRoles).not.toContain("auth_migrator");
    expect(h.io.readIdentity).toHaveBeenCalledTimes(3);
  });

  it("allows only named environment references, never URL values or ambiguous connection shapes", () => {
    expect(
      repositoryProductionSecretConnectionSchema.safeParse({
        ...secrets,
        authRuntimeEnvironment: uri("auth", "auth_runtime"),
      }).success,
    ).toBe(false);
    expect(
      repositoryProductionSecretConnectionSchema.safeParse({ ...secrets, connector: "preview" })
        .success,
    ).toBe(false);
  });
});
