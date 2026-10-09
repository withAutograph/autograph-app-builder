/* oxlint-disable anti-slop/no-module-mocking -- These cases exercise failures at the actual lazy import boundary while keeping constructors and database I/O inert; the existing injected opener cannot reproduce module loading failures. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { createHostedOperatorDeploymentOwnerContextResolver } from "./hosted-operator-owner-context";
import type { HostedOperatorConsentMetadata } from "./hosted-operator-consent-diagnostic";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "canonical-owner",
  workspaceId: "workspace",
};
const principal = { ...authority, scopes: ["autograph:get", "autograph:send"] };
const auth = {
  attributes: {
    "mcp:audience": authority.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: principal.ownerUserId,
  principalType: "user",
  subject: principal.ownerUserId,
};
const environment = {
  BETTER_AUTH_URL: authority.issuer,
  DATABASE_URL: "postgresql://fixture_owner@db.example/owner_db",
  MCP_RESOURCE_URL: authority.audience,
};
const fixture = () => {
  const activeMember = vi.fn(async () => await Promise.resolve(true));
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 7,
    adapterSessionId: "adapter-current",
    createdAtEpochMs: 1000,
    lastProgressAtEpochMs: 1000,
    originAdapterSessionId: "adapter-original",
    principal,
    resumability: "live",
    sessionId: "original-public-session",
    stage: "prototype",
    status: "waiting",
    title: "Original app",
    updatedAtEpochMs: 1000,
    version: 2,
  });
  const stores = {
    handoffs: {
      read: async () => {
        await Promise.resolve();
        throw new Error("Direct fixture has no handoff");
      },
    },
    isActiveMember: activeMember,
    sessions: {
      getSession: async () => await Promise.resolve(session),
      getSessionByAdapterSessionId: async () => await Promise.resolve(session),
    },
  };
  const openStores = vi.fn(async () => await Promise.resolve(stores));
  return { activeMember, openStores, stores };
};

afterEach(async () => {
  await vi.dynamicImportSettled();
  vi.doUnmock("../mcp/hosted-route");
  vi.doUnmock("../handoff/postgres-store");
  vi.doUnmock("../eve/postgres-hosted-store");
  vi.doUnmock("../auth/postgres-organization-user-authority");
  vi.restoreAllMocks();
  vi.resetModules();
});

type OwnerImportModule = NonNullable<HostedOperatorConsentMetadata["ownerStoreImport"]>["module"];
const mockStoreModules = (failedImport?: OwnerImportModule) => {
  const f = fixture();
  const openDatabase = vi.fn(() => ({}));
  const handoff = vi.fn(() => f.stores.handoffs);
  const sessions = vi.fn(() => f.stores.sessions);
  const membership = vi.fn(() => ({ isActiveMember: f.activeMember }));
  const assertImport = (module: OwnerImportModule) => {
    if (failedImport === module) {
      throw new Error("private import credential https://private.example");
    }
  };
  vi.doMock("../mcp/hosted-route", () => {
    assertImport("database");
    return { openHostedPostgresDatabase: openDatabase };
  });
  vi.doMock("../handoff/postgres-store", () => {
    assertImport("handoff");
    return { createPostgresBuilderHandoffStore: handoff };
  });
  vi.doMock("../eve/postgres-hosted-store", () => {
    assertImport("session");
    return { createPostgresHostedEveStore: sessions };
  });
  vi.doMock("../auth/postgres-organization-user-authority", () => {
    assertImport("membership");
    return { createPostgresPreviewOrganizationAuthority: membership };
  });
  return { ...f, handoff, membership, openDatabase, sessions };
};

const ownerInput = {
  adapterSessionId: "adapter-current",
  authority,
  principal,
  sessionAuth: { current: auth, initiator: auth },
};

describe("deployed owner reader with narrow configuration", () => {
  it("composes the actual deployment resolver with only the three owner-reader inputs", async () => {
    const f = fixture();
    const readerEnvironment = { ...environment };
    Object.defineProperty(readerEnvironment, "BETTER_AUTH_SECRET", {
      get: () => {
        throw new Error("Signing secret must not be read");
      },
    });
    Object.defineProperty(readerEnvironment, "EVE_HOSTED_ADAPTER", {
      get: () => {
        throw new Error("Hosted mode must not be read");
      },
    });
    const resolver = await createHostedOperatorDeploymentOwnerContextResolver(
      readerEnvironment,
      f.openStores,
    );
    const input = {
      adapterSessionId: "adapter-current",
      authority,
      principal,
      sessionAuth: { current: auth, initiator: auth },
    };
    await expect(resolver(input)).resolves.toMatchObject({
      adapterGeneration: 7,
      kind: "direct",
      sessionId: "original-public-session",
    });
    expect(f.openStores).toHaveBeenCalledWith({
      databaseUrl: environment.DATABASE_URL,
      issuer: authority.issuer,
      resource: authority.audience,
    });
    expect(f.activeMember).toHaveBeenCalledWith(authority);
    f.activeMember.mockResolvedValue(false);
    await expect(resolver(input)).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.openStores).toHaveBeenCalledTimes(1);
    expect(f.activeMember).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid canonical URLs before opening private storage", async () => {
    const f = fixture();
    await expect(
      createHostedOperatorDeploymentOwnerContextResolver(
        { ...environment, MCP_RESOURCE_URL: "https://foreign.example/mcp" },
        f.openStores,
      ),
    ).rejects.toThrow();
    expect(f.openStores).not.toHaveBeenCalled();
  });
  it.each([
    ["DATABASE_URL", undefined, "databaseUrlConfigured", false],
    [
      "DATABASE_URL",
      "postgresql://private:credential@ep-direct.aws.neon.tech/private?sslmode=require",
      "databasePolicyValid",
      false,
    ],
    [
      "DATABASE_URL",
      "postgresql://private:credential@ep-direct-pooler.aws.neon.tech/private",
      "databasePolicyValid",
      false,
    ],
    ["BETTER_AUTH_URL", "https://private.example/incorrect", "issuerCanonical", false],
    ["MCP_RESOURCE_URL", "https://foreign-private.example/mcp", "resourceCanonical", false],
  ] as const)(
    "classifies invalid %s using fixed booleans without retaining the configuration",
    async (key, value, diagnostic, expected) => {
      const f = fixture();
      const rejected = createHostedOperatorDeploymentOwnerContextResolver(
        { ...environment, [key]: value },
        f.openStores,
      );
      await expect(rejected).rejects.toMatchObject({
        ownerConfiguration: { [diagnostic]: expected },
        stage: "owner_configuration_parse",
      });
      await expect(rejected).rejects.not.toHaveProperty("cause");
      await expect(rejected).rejects.toHaveProperty("message", "Owner initialization unavailable.");
      expect(f.openStores).not.toHaveBeenCalled();
    },
  );
  it.each(["database", "handoff", "session", "membership"] as const)(
    "reports the exact %s import without exposing its exception",
    async (module) => {
      const f = mockStoreModules(module);
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      const deployed = await import("./hosted-operator-owner-context");
      const rejected = deployed.createHostedOperatorDeploymentOwnerContextResolver(environment);
      await expect(rejected).rejects.toMatchObject({
        ownerStoreImport: { module },
        stage: "owner_store_import",
      });
      await expect(rejected).rejects.not.toHaveProperty("cause");
      await expect(rejected).rejects.toHaveProperty("message", "Owner initialization unavailable.");
      await expect(
        deployed.resolveHostedOperatorOwnerContext({ ...ownerInput, environment }),
      ).rejects.toMatchObject({ code: "operator_unavailable" });
      expect(JSON.stringify(log.mock.calls)).toContain(`"module":"${module}"`);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      expect(f.openDatabase).not.toHaveBeenCalled();
    },
  );
  it.each(["openDatabase", "handoff", "sessions", "membership"] as const)(
    "classifies failed %s store construction without exposing its exception",
    async (factory) => {
      const f = mockStoreModules();
      f[factory].mockImplementation(() => {
        throw new Error("private constructor credential https://private.example");
      });
      const deployed = await import("./hosted-operator-owner-context");
      const rejected = deployed.createHostedOperatorDeploymentOwnerContextResolver(environment);
      await expect(rejected).rejects.toMatchObject({ stage: "owner_store_construction" });
      await expect(rejected).rejects.not.toHaveProperty("cause");
      await expect(rejected).rejects.toHaveProperty("message", "Owner initialization unavailable.");
    },
  );
  it("classifies an injected opener failure without changing its single-config signature", async () => {
    const f = fixture();
    f.openStores.mockRejectedValue(new Error("private injected opener failure"));
    await expect(
      createHostedOperatorDeploymentOwnerContextResolver(environment, f.openStores),
    ).rejects.toMatchObject({ stage: "owner_store_construction" });
    expect(f.openStores).toHaveBeenCalledExactlyOnceWith({
      databaseUrl: environment.DATABASE_URL,
      issuer: environment.BETTER_AUTH_URL,
      resource: environment.MCP_RESOURCE_URL,
    });
  });
  it("reports the closed configuration stage and retries initialization with current owner checks", async () => {
    const f = mockStoreModules();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const deployed = await import("./hosted-operator-owner-context");
    await expect(
      deployed.resolveHostedOperatorOwnerContext({
        ...ownerInput,
        environment: { ...environment, DATABASE_URL: "" },
      }),
    ).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(log).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({
        outcome: "setup_unavailable",
        stage: "owner_configuration_parse",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).toContain('"databaseUrlConfigured":false');
    expect(JSON.stringify(log.mock.calls)).not.toContain(authority.issuer);
    expect(f.openDatabase).not.toHaveBeenCalled();
    await expect(
      deployed.resolveHostedOperatorOwnerContext({ ...ownerInput, environment }),
    ).resolves.toMatchObject({ adapterGeneration: 7, sessionId: "original-public-session" });
    expect(f.openDatabase).toHaveBeenCalledOnce();
    f.activeMember.mockResolvedValue(false);
    await expect(
      deployed.resolveHostedOperatorOwnerContext({ ...ownerInput, environment }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });
  it("reports a constructor failure, resets the cached promise and retries without retaining errors", async () => {
    const f = mockStoreModules();
    f.openDatabase.mockImplementationOnce(() => {
      throw new Error("private credential https://private.example");
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const deployed = await import("./hosted-operator-owner-context");
    await expect(
      deployed.resolveHostedOperatorOwnerContext({ ...ownerInput, environment }),
    ).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(log).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({ outcome: "setup_unavailable", stage: "owner_store_construction" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    await expect(
      deployed.resolveHostedOperatorOwnerContext({ ...ownerInput, environment }),
    ).resolves.toMatchObject({ adapterGeneration: 7, sessionId: "original-public-session" });
    expect(f.openDatabase).toHaveBeenCalledTimes(2);
  });
});
