import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import { readHostedOperatorProviderInventory } from "./hosted-operator-provider-inventory";
import type { OperatorInventoryConfiguration } from "./hosted-operator-provider-inventory";
import type { HostedOperatorConsentDiagnosticSink } from "./hosted-operator-consent-diagnostic";

const requestUrl = (request: Parameters<typeof fetch>[0]): string => {
  if (request instanceof Request) {
    return request.url;
  }
  if (request instanceof URL) {
    return request.href;
  }
  return request;
};

const publicJwk = {
  ...generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }),
  alg: "EdDSA",
  kid: "public-key",
  use: "sig",
};

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context = {
  authority,
  target: {
    appId: "spend-review",
    branch: "feature/preview",
    environment: "preview" as const,
    installationId: "icfg_owner",
    projectId: "prj_app",
    scopeId: "team_owner",
    scopeType: "team" as const,
    sessionId: "original-session",
  },
};
const configuration: OperatorInventoryConfiguration = {
  app: {
    branch: context.target.branch,
    deploymentId: "dpl_app",
    environment: "preview",
    projectId: "prj_app",
  },
  gateway: {
    branch: context.target.branch,
    deploymentId: "dpl_gateway",
    environment: "preview",
    projectId: "prj_gateway",
  },
  operator: { deploymentId: "dpl_operator", environment: "production", projectId: "prj_operator" },
  verification: {
    gatewayOrigin: "https://gateway.example.test",
    publicOrigin: "https://gateway.example.test",
  },
};
const binding: VercelInstallationBinding = {
  active: true,
  displayName: "Owner",
  installationId: "icfg_owner",
  plan: "pro",
  scopeId: "team_owner",
  scopeType: "team",
  slug: "owner",
  updatedAt: new Date(),
};
const fixture = () => {
  const payloads = new Map<string, object>();
  for (const role of ["app", "gateway", "operator"] as const) {
    // Known fixture references have the same project/deployment shape.
    const selected = configuration[role];
    payloads.set(`/v9/projects/${selected.projectId}`, {
      accountId: "team_owner",
      id: selected.projectId,
      secret: "discarded-project-secret",
    });
    payloads.set(`/v13/deployments/${selected.deploymentId}`, {
      env: role === "app" ? ["SPEND_REVIEW_DATABASE_URL", "PLATFORM_JWKS_URL"] : [],
      gitSource: { ref: context.target.branch },
      id: selected.deploymentId,
      ownerId: "team_owner",
      projectId: selected.projectId,
      readyState: "READY",
      secret: "discarded-deployment-secret",
      target: selected.environment === "production" ? "production" : null,
      url: `${role}.example.test`,
    });
    payloads.set(`/v10/projects/${selected.projectId}/env`, {
      envs:
        role === "operator"
          ? [
              {
                configurationId: "icfg_neon",
                key: "DATABASE_URL_UNPOOLED",
                target: ["production"],
                value: "postgres://admin:private-password@ep.neon.tech/neondb",
              },
            ]
          : [{ key: "PLATFORM_JWKS_URL", target: ["preview"], value: "discarded-private-value" }],
    });
  }
  payloads.set("/v2/deployments/dpl_gateway/aliases", {
    aliases: [{ alias: "gateway.example.test" }],
  });
  payloads.set("/v1/storage/stores", {
    stores: [
      {
        id: "store_arrusted",
        product: { integrationConfigurationId: "icfg_neon", slug: "neon" },
        projectsMetadata: [{ projectId: "prj_operator" }],
        status: "available",
        type: "integration",
      },
    ],
  });
  payloads.set("/v1/storage/stores/store_arrusted", {
    store: {
      externalResourceId: "bitter-lab-49627418",
      id: "store_arrusted",
      ownerId: "team_owner",
      product: { integrationConfigurationId: "icfg_neon", slug: "neon" },
      projectsMetadata: [{ projectId: "prj_operator" }],
      secret: "discarded-store-secret",
      status: "available",
      type: "integration",
    },
  });
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    await Promise.resolve();
    const parsed = url instanceof Request ? new URL(url.url) : new URL(url);
    if (
      [
        "https://gateway.example.test",
        "https://gateway-old.example.test",
        "https://gateway-current.example.test",
        "https://gateway-successor.example.test",
      ].includes(parsed.origin)
    ) {
      return Response.json({
        keys: [publicJwk],
      });
    }
    expect(options?.method).toBe("GET");
    expect(parsed.searchParams.get("teamId")).toBe("team_owner");
    const deploymentPath =
      parsed.pathname === "/v13/deployments/gateway.example.test"
        ? "/v13/deployments/dpl_gateway"
        : parsed.pathname;
    const payload = payloads.get(parsed.pathname) ?? payloads.get(deploymentPath);
    return payload === undefined
      ? Response.json({ error: "missing" }, { status: 404 })
      : Response.json(payload);
  });
  const assertCurrentOwner = vi.fn(async () => {
    await Promise.resolve();
  });
  const readVercelCredential = vi.fn(
    async () => await Promise.resolve({ binding, token: "private-owner-token" }),
  );
  const input = {
    assertCurrentOwner,
    configuration,
    context,
    fetch: fetcher,
    readVercelCredential,
  };
  return { fetcher, input, payloads, readVercelCredential };
};

describe("private read-only operator provider inventory", () => {
  it.each([
    ["non-OK response", "http_response", 503],
    ["malformed JSON", "json_decode", undefined],
    ["malformed 2xx schema", "schema", 200],
    ["rejected fetch", "fetch", undefined],
  ] as const)("reports a closed inventory read phase for %s", async (_label, phase, status) => {
    const f = fixture();
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const projectUrl = `https://api.vercel.com/v9/projects/${configuration.app.projectId}?teamId=${context.target.scopeId}`;
    f.fetcher.mockImplementation(async (url, options) => {
      const parsed = new URL(url instanceof Request ? url.url : url.toString());
      if (parsed.pathname === "/v9/projects/prj_app") {
        if (phase === "fetch") {
          throw new Error("secret https://private.example/path");
        }
        if (phase === "json_decode") {
          return new Response("not-json", { status: 200 });
        }
        if (phase === "schema") {
          return Response.json({ privatePayload: "do-not-log" });
        }
        return Response.json({ error: "private provider response" }, { status: status ?? 503 });
      }
      expect(parsed.origin + parsed.pathname + parsed.search).not.toBe(projectUrl);
      const original = fixture().fetcher.getMockImplementation();
      if (original === undefined) {
        throw new Error("fixture missing");
      }
      return await original(url, options);
    });
    await expect(readHostedOperatorProviderInventory({ ...f.input, diagnosticSink: sink })).rejects.toThrow(
      "operator_unavailable",
    );
    expect(sink.mock.calls.map(([event]) => event.inventoryReadFailure)).toContainEqual(
      expect.objectContaining({
        target: "app",
        operation: "project",
        phase,
        ...(status && phase === "http_response"
          ? { httpStatus: status, errorClass: "operator_error", publicCode: "operator_unavailable" }
          : {}),
      }),
    );
    expect(sink.mock.calls.filter(([event]) => event.inventoryReadFailure !== undefined)).toHaveLength(1);
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/private\.example|do-not-log|private provider response/u);
  });

  it("attributes owner and credential failures and does not alert for the expected bootstrap alias 404", async () => {
    const owner = fixture();
    const ownerSink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    owner.input.assertCurrentOwner.mockRejectedValue(new Error("owner-secret"));
    await expect(readHostedOperatorProviderInventory({ ...owner.input, diagnosticSink: ownerSink })).rejects.toThrow(
      "operator_unavailable",
    );
    expect(ownerSink.mock.calls[0]?.[0].inventoryReadFailure).toMatchObject({
      target: "inventory", operation: "owner", phase: "owner",
    });
    expect(owner.fetcher).not.toHaveBeenCalled();

    const credential = fixture();
    const credentialSink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    credential.readVercelCredential.mockRejectedValue(new Error("credential-secret"));
    await expect(readHostedOperatorProviderInventory({ ...credential.input, diagnosticSink: credentialSink })).rejects.toThrow(
      "operator_unavailable",
    );
    expect(credentialSink.mock.calls[0]?.[0].inventoryReadFailure).toMatchObject({
      target: "inventory", operation: "credential", phase: "credential",
    });
    expect(credential.fetcher).not.toHaveBeenCalled();

    const alias = fixture();
    const aliasSink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    alias.input.configuration = {
      ...configuration,
      gateway: { ...configuration.gateway, deploymentId: undefined },
    };
    alias.fetcher.mockImplementation(async (url, options) => {
      const parsed = new URL(url instanceof Request ? url.url : url.toString());
      if (parsed.pathname === "/v13/deployments/gateway.example.test") {
        return Response.json({}, { status: 404 });
      }
      const original = fixture().fetcher.getMockImplementation();
      if (original === undefined) {
        throw new Error("fixture missing");
      }
      return await original(url, options);
    });
    await expect(readHostedOperatorProviderInventory({
      ...alias.input, phase: "bootstrap-planning", resolveGatewayByPublicOrigin: true,
      diagnosticSink: aliasSink,
    })).resolves.toBeDefined();
    expect(aliasSink.mock.calls.some(([event]) => event.inventoryReadFailure)).toBe(false);
  });

  it("keeps concurrent role attribution local and preserves the rejected public result with hostile diagnostics", async () => {
    const f = fixture();
    const observed: unknown[] = [];
    f.fetcher.mockImplementation(async (url, options) => {
      const parsed = new URL(url instanceof Request ? url.url : url.toString());
      if (parsed.pathname === "/v9/projects/prj_app" || parsed.pathname === "/v9/projects/prj_gateway") {
        observed.push(parsed.pathname);
        await Promise.resolve();
        return Response.json({ malformed: true });
      }
      const original = fixture().fetcher.getMockImplementation();
      if (original === undefined) {
        throw new Error("fixture missing");
      }
      return await original(url, options);
    });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(readHostedOperatorProviderInventory({
      ...f.input, diagnosticSink: sink,
    })).rejects.toThrow("operator_unavailable");
    expect(observed).toHaveLength(2);
    expect(sink.mock.calls.map(([event]) => event.inventoryReadFailure)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "app", operation: "project", phase: "schema" }),
        expect.objectContaining({ target: "gateway", operation: "project", phase: "schema" }),
      ]),
    );
    const projectReads = f.fetcher.mock.calls
      .map(([url]) => new URL(url instanceof Request ? url.url : url.toString()).pathname)
      .filter((path) => path.startsWith("/v9/projects/"));
    expect(projectReads).toHaveLength(3);
    expect(new Set(projectReads).size).toBe(3);

    const hostile = new Proxy(vi.fn<HostedOperatorConsentDiagnosticSink>(), {
      apply() {
        throw new Error("sink-private");
      },
    });
    await expect(readHostedOperatorProviderInventory({ ...f.input, diagnosticSink: hostile }))
      .rejects.toThrow("operator_unavailable");
  });

  it("reports malformed final inventory before preserving its sanitized public error", async () => {
    const f = fixture();
    const secret = "https://private-host/private-path?token=private-token";
    f.payloads.set("/v9/projects/prj_app", { privatePayload: secret });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(readHostedOperatorProviderInventory(f.input)).rejects.toThrow(
        "operator_unavailable",
      );
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: {
            stage: "final_inventory_readback",
            errorClass: "validation_error",
          },
        }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });
  it("accepts null provider configuration IDs without inventing native integration proof", async () => {
    const f = fixture();
    f.payloads.set("/v10/projects/prj_app/env", {
      envs: [
        {
          key: "PLATFORM_JWKS_URL",
          configurationId: null,
          target: ["preview"],
          value: "private-app-value",
        },
      ],
    });
    f.payloads.set("/v10/projects/prj_operator/env", {
      envs: [
        {
          key: "DATABASE_URL_UNPOOLED",
          configurationId: null,
          target: ["production"],
          value: "postgres://private-password@private-host/db",
        },
      ],
    });
    const observed = await readHostedOperatorProviderInventory(f.input);
    expect(observed.app.projectEnvironmentKeys).toContain("PLATFORM_JWKS_URL");
    expect(observed.operator.projectEnvironmentKeys).toContain("DATABASE_URL_UNPOOLED");
    expect(observed.nativeResource).toBeNull();
    const providerPaths = f.fetcher.mock.calls.map(
      ([url]) => new URL(url instanceof Request ? url.url : url.toString()).pathname,
    );
    expect(providerPaths).not.toContain("/v1/storage/stores");
    expect(JSON.stringify(observed)).not.toContain("private-app-value");
    expect(JSON.stringify(observed)).not.toContain("private-password");
  });

  it("retains inherited Preview variables on main and excludes foreign branches without requesting exact-branch metadata", async () => {
    const f = fixture();
    f.payloads.set("/v10/projects/prj_app/env", {
      envs: [
        {
          key: "PLATFORM_JWKS_URL",
          configurationId: null,
          gitBranch: null,
          target: ["preview"],
          value: "private-inherited-value",
        },
        {
          key: "APP_MODE",
          gitBranch: "main",
          target: ["preview"],
          value: "private-matching-value",
        },
        {
          key: "BETTER_AUTH_SECRET",
          configurationId: null,
          target: ["preview"],
          value: "private-app-secret",
        },
        {
          key: "PGUSER",
          gitBranch: "foreign",
          target: ["preview"],
          value: "private-foreign-value",
        },
        { key: "PRODUCTION_ONLY", target: ["production"], value: "private-production-value" },
      ],
    });
    for (const role of ["app", "gateway"] as const) {
      const deployment = `/v13/deployments/${configuration[role].deploymentId}`;
      f.payloads.set(deployment, { ...f.payloads.get(deployment), gitSource: { ref: "main" } });
    }
    const read = f.fetcher.getMockImplementation();
    if (read === undefined) {
      throw new Error("Missing fixture fetch.");
    }
    f.fetcher.mockImplementation(async (url, options) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      if (parsed.pathname.endsWith("/env") && parsed.searchParams.has("gitBranch")) {
        return Response.json({ envs: [] });
      }
      return await read(url, options);
    });
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      context: { ...context, target: { ...context.target, branch: "main" } },
      configuration: {
        ...configuration,
        app: { ...configuration.app, branch: "main" },
        gateway: { ...configuration.gateway, branch: "main" },
      },
    });
    expect(observed.app.projectEnvironmentKeys).toEqual([
      "APP_MODE",
      "BETTER_AUTH_SECRET",
      "PLATFORM_JWKS_URL",
    ]);
    expect(observed.appEnvironment.forbiddenKeys).toEqual(["BETTER_AUTH_SECRET"]);
    const envRequests = f.fetcher.mock.calls
      .map(([url]) => new URL(url instanceof Request ? url.url : url.toString()))
      .filter((url) => url.pathname.endsWith("/env"));
    expect(envRequests.every((url) => !url.searchParams.has("gitBranch"))).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("private-inherited-value");
    expect(JSON.stringify(observed)).not.toContain("private-matching-value");
    expect(JSON.stringify(observed)).not.toContain("private-app-secret");
    expect(JSON.stringify(observed)).not.toContain("private-foreign-value");
  });

  it("recognizes native staging deployments only with Preview claims and no custom environment", async () => {
    const f = fixture();
    const previewConfig = {
      ...configuration,
      operator: { ...configuration.operator, environment: "preview" as const },
    };
    for (const role of ["app", "gateway", "operator"] as const) {
      const key = `/v13/deployments/${configuration[role].deploymentId}`;
      f.payloads.set(key, {
        ...f.payloads.get(key),
        customEnvironment: null,
        oidcTokenClaims: { environment: "preview", project_id: configuration[role].projectId },
        target: "staging",
      });
    }
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      configuration: previewConfig,
    });
    expect(observed.operator.environment).toBe("preview");
    expect(observed.operator.deploymentId).toBe("dpl_operator");
    await Promise.all(
      [
        { oidcTokenClaims: { environment: "preview" }, target: "production" },
        { target: "staging" },
        { oidcTokenClaims: { environment: "production" }, target: "staging" },
        { oidcTokenClaims: { environment: "preview-lookalike" }, target: "staging" },
        { oidcTokenClaims: { environment: ["preview"] }, target: "staging" },
        {
          customEnvironment: { id: "env_custom", slug: "staging" },
          oidcTokenClaims: { environment: "preview" },
          target: "staging",
        },
      ].map(async (metadata) => {
        const invalid = fixture();
        invalid.payloads.set("/v13/deployments/dpl_operator", {
          ...invalid.payloads.get("/v13/deployments/dpl_operator"),
          ...metadata,
        });
        await expect(
          readHostedOperatorProviderInventory({ ...invalid.input, configuration: previewConfig }),
        ).rejects.toThrow("resource_mismatch");
      }),
    );
  });
  it("plans owned fresh projects without fabricating deployment or public-key evidence", async () => {
    const f = fixture();
    const { deploymentId: appDeployment, ...app } = configuration.app;
    const { deploymentId: gatewayDeployment, ...gateway } = configuration.gateway;
    void appDeployment;
    void gatewayDeployment;
    f.payloads.delete("/v13/deployments/dpl_gateway");
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      configuration: { ...configuration, app, gateway },
      phase: "bootstrap-planning",
    });
    expect(observed.app).not.toHaveProperty("deploymentId");
    expect(observed.gateway).not.toHaveProperty("deploymentId");
    expect(observed.operator.deploymentId).toBe("dpl_operator");
    expect(observed.appEnvironment.deployedKeyInventory).toBe("unconfirmed");
    expect(observed.verification.publicKeyIds).toBeNull();
    const requested = f.fetcher.mock.calls.map(
      ([url]) => new URL(url instanceof Request ? url.url : url.toString()).pathname,
    );
    expect(requested).not.toContain("/v13/deployments/undefined");
    expect(requested).not.toContain("/v13/deployments/dpl_app");
    expect(requested).not.toContain("/v13/deployments/dpl_gateway");
    expect(requested).not.toContain("/_platform/jwks.json");
    expect(requested).toContain("/v10/projects/prj_app/env");
    expect(requested).toContain("/v10/projects/prj_gateway/env");
    await expect(
      readHostedOperatorProviderInventory({
        ...f.input,
        configuration: { ...configuration, app, gateway },
      }),
    ).rejects.toThrow("resource_mismatch");
  });
  it("rejects foreign empty projects and absent operator evidence during bootstrap planning", async () => {
    const f = fixture();
    const { deploymentId, ...gateway } = configuration.gateway;
    void deploymentId;
    f.payloads.set("/v9/projects/prj_gateway", { accountId: "foreign", id: "prj_gateway" });
    await expect(
      readHostedOperatorProviderInventory({
        ...f.input,
        configuration: { ...configuration, gateway },
        phase: "bootstrap-planning",
      }),
    ).rejects.toThrow("resource_mismatch");
    const second = fixture();
    await expect(
      readHostedOperatorProviderInventory({
        ...second.input,
        configuration: {
          ...configuration,
          operator: { ...configuration.operator, deploymentId: "missing" },
        },
        phase: "bootstrap-planning",
      }),
    ).rejects.toThrow("operator_unavailable");
  });
  it("treats a missing planning alias as undelivered even when an older configured deployment exists", async () => {
    const f = fixture();
    f.payloads.delete("/v13/deployments/dpl_gateway");
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      phase: "bootstrap-planning",
      resolveGatewayByPublicOrigin: true,
    });
    expect(observed.gateway.deploymentId).toBeUndefined();
    expect(observed.verification.publicKeyIds).toBeNull();
    await expect(
      readHostedOperatorProviderInventory({ ...f.input, phase: "bootstrap-planning" }),
    ).rejects.toThrow("operator_unavailable");
  });
  it.each([null, {}])(
    "rejects a successful malformed deployment response instead of treating it as missing: %j",
    async (payload) => {
      const f = fixture();
      const originalFetch = f.input.fetch;
      const fetcher: typeof fetch = async (url, options) => {
        const parsed = url instanceof Request ? new URL(url.url) : new URL(url);
        return parsed.pathname.startsWith("/v13/deployments/") &&
          parsed.pathname !== "/v13/deployments/dpl_operator" &&
          parsed.pathname !== "/v13/deployments/dpl_app"
          ? Response.json(payload)
          : await originalFetch(url, options);
      };
      await expect(
        readHostedOperatorProviderInventory({
          ...f.input,
          fetch: fetcher,
          phase: "bootstrap-planning",
          resolveGatewayByPublicOrigin: true,
        }),
      ).rejects.toThrow("operator_unavailable");
      await expect(
        readHostedOperatorProviderInventory({
          ...f.input,
          fetch: fetcher,
          phase: "bootstrap-planning",
        }),
      ).rejects.toThrow("operator_unavailable");
    },
  );
  const movedPublicAlias = () => {
    const f = fixture();
    const frozen = f.payloads.get("/v13/deployments/dpl_gateway");
    f.payloads.set("/v13/deployments/dpl_gateway", { ...frozen, url: "gateway-old.example.test" });
    f.payloads.set("/v2/deployments/dpl_gateway/aliases", { aliases: [] });
    f.payloads.set("/v13/deployments/gateway.example.test", {
      ...frozen,
      id: "dpl_current",
      url: "gateway-current.example.test",
    });
    return {
      ...f,
      input: {
        ...f.input,
        configuration: {
          ...configuration,
          verification: {
            ...configuration.verification,
            gatewayOrigin: "https://gateway-old.example.test",
          },
        },
      },
    };
  };
  it("keeps the exact approved transport when its public alias advances within the same native boundary", async () => {
    const f = movedPublicAlias();
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      phase: "bootstrap-planning",
    });
    expect(observed.gateway.deploymentId).toBe("dpl_gateway");
    expect(observed.verification.gatewayOrigin).toBe("https://gateway-old.example.test");
    expect(observed.verification.publicOrigin).toBe("https://gateway.example.test");
    expect(observed.verification.publicKeyIds).toEqual(["public-key"]);
  });
  it.each([
    { projectId: "foreign" },
    { ownerId: "foreign" },
    { target: "production" },
    { gitSource: { ref: "another-branch" } },
    { readyState: "BUILDING" },
  ])("rejects a moved public alias outside the approved native boundary: %j", async (patch) => {
    const f = movedPublicAlias();
    f.payloads.set("/v13/deployments/gateway.example.test", {
      ...f.payloads.get("/v13/deployments/gateway.example.test"),
      ...patch,
    });
    await expect(
      readHostedOperatorProviderInventory({ ...f.input, phase: "bootstrap-planning" }),
    ).rejects.toThrow("resource_mismatch");
  });
  it.each([null, {}])("rejects malformed current public alias evidence: %j", async (payload) => {
    const f = movedPublicAlias();
    const originalFetch = f.input.fetch;
    const fetcher: typeof fetch = async (url, options) => {
      const parsed = url instanceof Request ? new URL(url.url) : new URL(url);
      return parsed.pathname === "/v13/deployments/gateway.example.test"
        ? Response.json(payload)
        : await originalFetch(url, options);
    };
    await expect(
      readHostedOperatorProviderInventory({
        ...f.input,
        fetch: fetcher,
        phase: "bootstrap-planning",
      }),
    ).rejects.toThrow("operator_unavailable");
  });
  it("rejects a missing current public alias without substituting another deployment", async () => {
    const f = movedPublicAlias();
    const originalFetch = f.input.fetch;
    const fetcher: typeof fetch = async (url, options) => {
      const parsed = url instanceof Request ? new URL(url.url) : new URL(url);
      return parsed.pathname === "/v13/deployments/gateway.example.test"
        ? Response.json({ error: "missing" }, { status: 404 })
        : await originalFetch(url, options);
    };
    await expect(
      readHostedOperatorProviderInventory({
        ...f.input,
        fetch: fetcher,
        phase: "bootstrap-planning",
      }),
    ).rejects.toThrow("operator_unavailable");
  });
  it("resolves the current trusted public alias during new planning while execution retains its fixed deployment", async () => {
    const f = fixture();
    const { gateway } = configuration;
    const successor = {
      ...f.payloads.get("/v13/deployments/dpl_gateway"),
      id: "dpl_successor",
      url: "gateway-successor.example.test",
    };
    f.payloads.set("/v13/deployments/dpl_gateway", successor);
    f.payloads.set("/v2/deployments/dpl_successor/aliases", {
      aliases: [{ alias: "gateway.example.test" }],
    });
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      phase: "bootstrap-planning",
      resolveGatewayByPublicOrigin: true,
    });
    expect(observed.gateway.deploymentId).toBe("dpl_successor");
    expect(observed.verification.gatewayOrigin).toBe("https://gateway-successor.example.test");
    expect(observed.verification.jwksUrl).toBe(
      "https://gateway-successor.example.test/_platform/jwks.json",
    );
    expect(observed.verification.publicOrigin).toBe(configuration.verification.publicOrigin);
    expect(configuration.gateway).toBe(gateway);
    await expect(
      readHostedOperatorProviderInventory({ ...f.input, phase: "bootstrap-planning" }),
    ).rejects.toThrow("resource_mismatch");
  });
  it("uses the current immutable transport during fresh planning despite an old configured endpoint", async () => {
    const f = movedPublicAlias();
    f.payloads.set("/v2/deployments/dpl_current/aliases", {
      aliases: [{ alias: "gateway.example.test" }],
    });
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      phase: "bootstrap-planning",
      resolveGatewayByPublicOrigin: true,
    });
    expect(observed.gateway.deploymentId).toBe("dpl_current");
    expect(observed.verification.gatewayOrigin).toBe("https://gateway-current.example.test");
    expect(observed.verification.jwksUrl).toBe(
      "https://gateway-current.example.test/_platform/jwks.json",
    );
    expect(observed.verification.publicOrigin).toBe(configuration.verification.publicOrigin);
    expect(
      f.fetcher.mock.calls.some(([request]) =>
        requestUrl(request).startsWith("https://gateway-current.example.test/_platform/jwks.json"),
      ),
    ).toBe(true);
    expect(
      f.fetcher.mock.calls.some(([request]) =>
        requestUrl(request).startsWith("https://gateway-old.example.test/"),
      ),
    ).toBe(false);
  });
  it.each([
    { ownerId: "foreign-owner" },
    { projectId: "foreign-project" },
    { gitSource: { ref: "foreign-branch" } },
    { target: "production" },
  ])("rejects an alias that resolves outside the approved Gateway boundary: %j", async (patch) => {
    const f = fixture();
    f.payloads.set("/v13/deployments/dpl_gateway", {
      ...f.payloads.get("/v13/deployments/dpl_gateway"),
      ...patch,
    });
    await expect(
      readHostedOperatorProviderInventory({
        ...f.input,
        phase: "bootstrap-planning",
        resolveGatewayByPublicOrigin: true,
      }),
    ).rejects.toThrow("resource_mismatch");
  });
  it("still rejects foreign and non-READY supplied candidates during bootstrap planning", async () => {
    await Promise.all(
      [{ projectId: "foreign" }, { readyState: "BUILDING" }].map(async (patch) => {
        const f = fixture();
        f.payloads.set("/v13/deployments/dpl_gateway", {
          ...f.payloads.get("/v13/deployments/dpl_gateway"),
          ...patch,
        });
        await expect(
          readHostedOperatorProviderInventory({
            ...f.input,
            phase: "bootstrap-planning",
          }),
        ).rejects.toThrow("resource_mismatch");
      }),
    );
  });
  it("observes three distinct owner-bound projects without returning provider secrets or claiming branch provenance", async () => {
    const f = fixture();
    const observed = await readHostedOperatorProviderInventory(f.input);
    expect(observed.app.projectId).toBe("prj_app");
    expect(observed.gateway.projectId).toBe("prj_gateway");
    expect(observed.operator.projectId).toBe("prj_operator");
    expect(observed.nativeResource).toEqual({
      neonProjectId: "bitter-lab-49627418",
      resourceId: "store_arrusted",
    });
    expect(observed.previewBranch.status).toBe("unconfirmed");
    expect(observed.protectedAppGrantPolicy).toBe("unconfirmed");
    const output = JSON.stringify(observed);
    for (const secret of [
      "private-owner-token",
      "private-password",
      "discarded-private-value",
      "discarded-store-secret",
      "discarded-project-secret",
      "discarded-deployment-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
    const publicCall = f.fetcher.mock.calls.find(([url]) =>
      (url instanceof Request ? url.url : url.toString()).startsWith(
        "https://gateway.example.test",
      ),
    );
    expect(publicCall?.[1]?.headers).toBeUndefined();
  });
  it("observes the approved publication branch independently of the resource branch", async () => {
    const f = fixture();
    const branch = "codex/generated-app";
    f.payloads.set("/v13/deployments/dpl_app", {
      gitSource: { ref: branch },
      id: "dpl_app",
      ownerId: "team_owner",
      projectId: "prj_app",
      readyState: "READY",
      target: null,
      url: "app.example.test",
    });
    const configured = { ...configuration, app: { ...configuration.app, branch } };
    await expect(
      readHostedOperatorProviderInventory({ ...f.input, configuration: configured }),
    ).rejects.toThrow("resource_mismatch");
    const observed = await readHostedOperatorProviderInventory({
      ...f.input,
      configuration: configured,
      approvedAppBranch: branch,
    });
    expect(observed.app.branch).toBe(branch);
    expect(context.target.branch).toBe("feature/preview");
  });
  it("rejects foreign ownership and mismatched exact preview branches", async () => {
    const f = fixture();
    f.payloads.set("/v9/projects/prj_gateway", { accountId: "other-team", id: "prj_gateway" });
    await expect(readHostedOperatorProviderInventory(f.input)).rejects.toThrow("resource_mismatch");
    const second = fixture();
    second.payloads.set("/v13/deployments/dpl_app", {
      gitSource: { ref: "another-branch" },
      id: "dpl_app",
      projectId: "prj_app",
      readyState: "READY",
      target: null,
      url: "app.example.test",
    });
    await expect(readHostedOperatorProviderInventory(second.input)).rejects.toThrow(
      "resource_mismatch",
    );
  });
  it("rejects shared projects before reading owner credentials", async () => {
    const f = fixture();
    await expect(
      readHostedOperatorProviderInventory({
        ...f.input,
        configuration: {
          ...configuration,
          operator: { ...configuration.operator, projectId: configuration.app.projectId },
        },
      }),
    ).rejects.toThrow("resource_mismatch");
    expect(f.readVercelCredential).not.toHaveBeenCalled();
  });
  it("reports forbidden deployed and inherited preview key names while discarding all values", async () => {
    const f = fixture();
    f.payloads.set("/v10/projects/prj_app/env", {
      envs: [
        { key: "BETTER_AUTH_SECRET", target: ["preview"], value: "secret-do-not-output" },
        {
          key: "PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY",
          target: ["preview"],
          value: "secret-do-not-output",
        },
        {
          key: "AUTOGRAPH_HOSTED_OPERATOR_CONTROL_KEY",
          target: ["preview"],
          value: "secret-do-not-output",
        },
        { key: "PRODUCTION_ONLY_SECRET", target: ["production"], value: "secret-do-not-output" },
      ],
    });
    const observed = await readHostedOperatorProviderInventory(f.input);
    expect(observed.appEnvironment.forbiddenKeys).toEqual([
      "AUTOGRAPH_HOSTED_OPERATOR_CONTROL_KEY",
      "BETTER_AUTH_SECRET",
      "PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY",
    ]);
    expect(observed.app.projectEnvironmentKeys).not.toContain("PRODUCTION_ONLY_SECRET");
    expect(JSON.stringify(observed)).not.toContain("secret-do-not-output");
  });
  it("does not treat missing deployed environment inventory as secret absence", async () => {
    const f = fixture();
    f.payloads.set("/v13/deployments/dpl_app", {
      gitSource: { ref: context.target.branch },
      id: "dpl_app",
      projectId: "prj_app",
      readyState: "READY",
      target: null,
      url: "app.example.test",
    });
    const observed = await readHostedOperatorProviderInventory(f.input);
    expect(observed.appEnvironment.deployedKeyInventory).toBe("unconfirmed");
  });
  it("sanitizes thrown provider errors instead of exposing bearer credentials", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(
      new Error("Bearer private-owner-token postgres://admin:password@host/db"),
    );
    await expect(readHostedOperatorProviderInventory(f.input)).rejects.toThrow(
      "operator_unavailable",
    );
  });
  it("never returns private JWK material or treats it as public verification", async () => {
    const f = fixture();
    const read = f.fetcher.getMockImplementation();
    if (read === undefined) {
      throw new Error("Fixture provider fetch is absent.");
    }
    f.fetcher.mockImplementation(async (url, options) => {
      const parsed = url instanceof Request ? new URL(url.url) : new URL(url);
      if (parsed.origin === "https://gateway.example.test") {
        return Response.json({
          keys: [
            {
              ...publicJwk,
              d: "private-ed25519-secret",
            },
          ],
        });
      }
      return await read(url, options);
    });
    const observed = await readHostedOperatorProviderInventory(f.input);
    expect(observed.verification.publicKeyIds).toBeNull();
    expect(JSON.stringify(observed)).not.toContain("private-ed25519-secret");
  });
  it("rejects wrong credential owner scope before any provider request", async () => {
    const f = fixture();
    f.readVercelCredential.mockResolvedValue({
      binding: { ...binding, scopeId: "another-team" },
      token: "foreign-token",
    });
    await expect(readHostedOperatorProviderInventory(f.input)).rejects.toThrow(
      "authorization_required",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("independently approved Gateway inventory branch", () => {
  const independent = () => {
    const f = fixture();
    const branch = "shared-auth-preview";
    f.input.configuration = { ...configuration, gateway: { ...configuration.gateway, branch } };
    const path = "/v13/deployments/dpl_gateway";
    f.payloads.set(path, { ...f.payloads.get(path), gitSource: { ref: branch } });
    return f;
  };
  it("verifies the Gateway provider ref against its own branch while preserving the selected App branch", async () => {
    const f = independent();
    const observed = await readHostedOperatorProviderInventory(f.input);
    expect(observed.app.branch).toBe(context.target.branch);
    expect(observed.gateway.branch).toBe("shared-auth-preview");
    expect(observed.gateway.projectId).toBe(configuration.gateway.projectId);
    expect(observed.gateway.deploymentId).toBe(configuration.gateway.deploymentId);
  });
  it.each([
    { gitSource: { ref: context.target.branch } },
    { projectId: configuration.app.projectId },
    { ownerId: "foreign-owner" },
    { target: "production" },
  ])(
    "rejects a Gateway provider tuple that differs from its own approved identity %#",
    async (mismatch) => {
      const f = independent();
      const path = "/v13/deployments/dpl_gateway";
      f.payloads.set(path, { ...f.payloads.get(path), ...mismatch });
      await expect(readHostedOperatorProviderInventory(f.input)).rejects.toThrow(
        "resource_mismatch",
      );
    },
  );
});
