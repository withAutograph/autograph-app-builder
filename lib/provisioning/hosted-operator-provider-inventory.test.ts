import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import { readHostedOperatorProviderInventory } from "./hosted-operator-provider-inventory";
import type { OperatorInventoryConfiguration } from "./hosted-operator-provider-inventory";

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
    if (parsed.origin === "https://gateway.example.test") {
      return Response.json({
        keys: [publicJwk],
      });
    }
    expect(options?.method).toBe("GET");
    expect(parsed.searchParams.get("teamId")).toBe("team_owner");
    return Response.json(payloads.get(parsed.pathname) ?? { error: "missing" });
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
