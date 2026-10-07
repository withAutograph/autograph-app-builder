import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { createNativePreviewNeonReader } from "./hosted-operator-native-preview-neon";
import type {
  NativePreviewNeonDependencies,
  NativePreviewNeonIo,
} from "./hosted-operator-native-preview-neon";

const mocks = {
  oidc: vi.fn<NativePreviewNeonIo["getOidc"]>(),
  query: vi.fn<NativePreviewNeonIo["readSqlIdentity"]>(),
  token: vi.fn<NativePreviewNeonIo["getOwnerToken"]>(),
  verify: vi.fn<NativePreviewNeonIo["verifyOidc"]>(),
};
const context: HostedOperatorContext = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: {
    appId: "spend-review",
    branch: "feature/preview",
    environment: "preview",
    installationId: "icfg-owner",
    projectId: "prj-app",
    scopeId: "team-owner",
    scopeType: "team",
    sessionId: "original-session",
  },
};
const scope = {
  branchId: "br-synthetic",
  endpointId: "ep-synthetic",
  hostname: "ep-synthetic.us-east-1.aws.neon.tech",
  maintenanceDatabase: "neondb",
  maintenanceRole: "bootstrap_owner",
  projectId: "native-project",
};
const config = {
  connector: "neon/owned",
  connectorInstallationId: "neon-connect-installation",
  nativeStore: {
    configurationId: "icfg-native-neon",
    resourceId: "store-native",
    sourceProjectId: "prj-source",
  },
  operator: {
    audience: "https://vercel.com/autographing",
    environment: "production" as const,
    issuer: "https://oidc.vercel.com/autographing",
    ownerId: "team-owner",
    projectId: "prj-operator",
  },
};
const uri = `postgresql://bootstrap_owner:private-password@${scope.hostname}/neondb?sslmode=require`;
const nativeStore = {
  configurationId: "icfg-native-neon",
  neonProjectId: "native-project",
  ownerId: "team-owner",
  resourceId: "store-native",
  vercelProjectId: "prj-source",
};
const fixture = (
  changes: {
    sourceProjectId?: string;
    uri?: string;
    branch?: { init_source?: string; default?: boolean };
    endpoint?: { branch_id?: string; project_id?: string; host?: string; type?: string };
  } = {},
) => {
  const owner = vi
    .fn<NativePreviewNeonDependencies["readCurrentOwnerNativeStore"]>()
    .mockResolvedValue(nativeStore);
  const approved = vi.fn(async () => {
    await Promise.resolve();
  });
  const fetcher = vi.fn(async (input: URL | RequestInfo, options?: RequestInit) => {
    let target: string;
    if (input instanceof Request) {
      target = input.url;
    } else if (input instanceof URL) {
      target = input.href;
    } else {
      target = input;
    }
    const url = new URL(target);
    let body;
    if (url.pathname.endsWith("/connection_uri")) {
      body = { uri: changes.uri ?? uri };
    } else if (url.pathname.includes("/endpoints/")) {
      body = {
        endpoint: {
          branch_id: scope.branchId,
          host: scope.hostname,
          id: scope.endpointId,
          project_id: scope.projectId,
          type: "read_write",
          ...changes.endpoint,
        },
      };
    } else if (url.pathname.includes("/databases/")) {
      body = { database: { branch_id: scope.branchId, name: scope.maintenanceDatabase } };
    } else if (url.pathname.includes("/roles/")) {
      body = { role: { branch_id: scope.branchId, name: scope.maintenanceRole } };
    } else {
      body = {
        branch: {
          default: false,
          id: scope.branchId,
          init_source: "schema-only",
          project_id: scope.projectId,
          ...changes.branch,
        },
      };
    }
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("error");
    await Promise.resolve();
    return Response.json(body);
  });
  return {
    approved,
    fetcher,
    owner,
    reader: createNativePreviewNeonReader({
      assertApprovedScope: approved,
      configuration: {
        ...config,
        nativeStore: {
          ...config.nativeStore,
          sourceProjectId: changes.sourceProjectId ?? config.nativeStore.sourceProjectId,
        },
      },
      fetch: fetcher,
      io: {
        getOidc: mocks.oidc,
        getOwnerToken: mocks.token,
        readSqlIdentity: mocks.query,
        verifyOidc: mocks.verify,
      },
      readCurrentOwnerNativeStore: owner,
    }),
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue("private-neon-bearer");
  mocks.oidc.mockResolvedValue("private-project-oidc");
  mocks.verify.mockResolvedValue();
  mocks.query.mockResolvedValue({
    database: scope.maintenanceDatabase,
    role: scope.maintenanceRole,
  });
});
describe("private native Preview reader", () => {
  it("uses verified project OIDC, fresh owner-subject Connect tokens and exact URI identifiers", async () => {
    const f = fixture();
    const consume = vi.fn(async (material: { maintenanceUrl: string }) => {
      expect(material.maintenanceUrl).toContain("sslmode=verify-full");
      return await Promise.resolve("private-effect-ready");
    });
    expect(await f.reader.withMaintenanceCredential(context, scope, consume)).toBe(
      "private-effect-ready",
    );
    expect(mocks.verify).toHaveBeenCalledWith("private-project-oidc", {
      audience: config.operator.audience,
      environment: "production",
      issuer: config.operator.issuer,
      ownerId: "team-owner",
      projectId: "prj-operator",
    });
    expect(mocks.token).toHaveBeenCalledTimes(5);
    expect(mocks.token).toHaveBeenCalledWith(
      "neon/owned",
      {
        installationId: "neon-connect-installation",
        subject: { id: "owner", issuer: context.authority.issuer, type: "user" },
      },
      { forceRefresh: true, vercelToken: "private-project-oidc" },
    );
    const url = new URL(
      f.fetcher.mock.calls[4]?.[0] instanceof URL
        ? f.fetcher.mock.calls[4][0].href
        : "https://fixture.invalid",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      branch_id: scope.branchId,
      database_name: scope.maintenanceDatabase,
      endpoint_id: scope.endpointId,
      pooled: "false",
      role_name: scope.maintenanceRole,
    });
    expect(f.owner).toHaveBeenCalledTimes(25);

    expect(consume).toHaveBeenCalledOnce();
  });
  it.each(["parent-data", "import", "empty", undefined])(
    "denies undocumented or copied branch provenance %s",
    async (initSource) => {
      const f = fixture({ branch: { init_source: initSource } });
      const consume = vi.fn();
      await expect(f.reader.withMaintenanceCredential(context, scope, consume)).rejects.toThrow(
        "Protected native Preview credential is unavailable.",
      );
      expect(consume).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
  it("accepts documented parent-schema metadata", async () => {
    const f = fixture({ branch: { init_source: "parent-schema" } });
    await expect(
      f.reader.withMaintenanceCredential(
        context,
        scope,
        async (material) => await Promise.resolve(material.initSource),
      ),
    ).resolves.toBe("parent-schema");
  });
  it.each([
    { branch_id: "br-other" },
    { project_id: "other-project" },
    { host: "ep-production.us-east-1.aws.neon.tech" },
    { type: "read_only" },
  ])("denies wrong endpoint identity %j", async (endpoint) => {
    const f = fixture({ endpoint });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([
    uri.replace("ep-synthetic.", "ep-synthetic-pooler."),
    uri.replace("bootstrap_owner:", "other_role:"),
    uri.replace("/neondb?", "/production?"),
    uri.replace("sslmode=require", "sslmode=disable"),
    `${uri}&options=-c%20role%3Dadmin`,
    `${uri}&sslmode=require`,
  ])("denies mismatched or unsafe private URI", async (value) => {
    const f = fixture({ uri: value });
    const consume = vi.fn();
    await expect(f.reader.withMaintenanceCredential(context, scope, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("denies unapproved scope before OIDC/provider access", async () => {
    const f = fixture();
    f.approved.mockRejectedValue(new Error("not approved"));
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(mocks.oidc).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("does not acquire a provider token if operator OIDC verification fails", async () => {
    mocks.verify.mockRejectedValue(new Error("wrong project"));
    const f = fixture();
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("denies owner revocation after token acquisition and before Neon transport", async () => {
    const f = fixture();
    mocks.token.mockImplementation(async () => {
      f.owner.mockRejectedValue(new Error("revoked"));
      return await Promise.resolve("private-neon-bearer");
    });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { vercelProjectId: "prj-other-source" },
    { resourceId: "store-other" },
    { configurationId: "icfg-other-native" },
    { neonProjectId: "wrong-native-project" },
  ])("denies mismatched deployment-owned native source binding %j", async (change) => {
    const f = fixture();
    f.owner.mockResolvedValue({ ...nativeStore, ...change });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("denies administrative native store attachment to the app project", async () => {
    const f = fixture({ sourceProjectId: "prj-app" });
    f.owner.mockResolvedValue({ ...nativeStore, vercelProjectId: "prj-app" });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("requires an explicit deployment-owned source project", async () => {
    const f = fixture({ sourceProjectId: "" });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(f.owner).not.toHaveBeenCalled();
    expect(mocks.oidc).not.toHaveBeenCalled();
  });
  it("keeps owner Vercel, Neon Connect and native integration identities separate", async () => {
    const f = fixture();
    await f.reader.withMaintenanceCredential(context, scope, async () => {});
    expect(context.target.installationId).not.toBe(config.nativeStore.configurationId);
    expect(config.connectorInstallationId).not.toBe(config.nativeStore.configurationId);
    expect(f.owner.mock.calls[0]?.[0].target.installationId).toBe("icfg-owner");
    expect(f.owner.mock.calls[0]?.[0].target.projectId).toBe("prj-app");
    expect(f.owner.mock.calls[0]?.[1]).toEqual(config.nativeStore);
    expect(config.nativeStore.sourceProjectId).not.toBe(context.target.projectId);
    expect(config.operator.projectId).not.toBe(config.nativeStore.sourceProjectId);
  });
  it("denies wrong owner before token acquisition", async () => {
    const f = fixture();
    f.owner.mockResolvedValue({
      configurationId: "icfg-native-neon",
      neonProjectId: "native-project",
      ownerId: "other",
      resourceId: "store-native",
      vercelProjectId: "prj-source",
    });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("denies revoked owner immediately after a provider read", async () => {
    const f = fixture();
    f.owner.mockImplementation(async () => {
      if (f.fetcher.mock.calls.length > 0) {
        throw new Error("revoked");
      }
      return await Promise.resolve({
        configurationId: "icfg-native-neon",
        neonProjectId: "native-project",
        ownerId: "team-owner",
        resourceId: "store-native",
        vercelProjectId: "prj-source",
      });
    });
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("does not fall back if OIDC or Connect is unavailable and hides vendor credentials", async () => {
    mocks.token.mockRejectedValue(new Error(`${uri} private-neon-bearer`));
    const f = fixture();
    await expect(
      f.reader.withMaintenanceCredential(context, scope, async () => {}),
    ).rejects.toThrow(/^Protected native Preview credential is unavailable\.$/u);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("denies mismatched SQL login/database before releasing private material", async () => {
    mocks.query.mockResolvedValue({ database: "production", role: "production_owner" });
    const f = fixture();
    const consume = vi.fn();
    await expect(f.reader.withMaintenanceCredential(context, scope, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
  });
});
