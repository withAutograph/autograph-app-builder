import { describe, expect, it } from "vitest";

import {
  buildHostedPreviewSourceConfigurationReceipt,
  hostedPreviewActivationReceiptSchema,
} from "./preview-configuration-receipt";

const configuration = {
  auth: {
    algorithm: "ES256",
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    jwksUrl: "https://builder.example.test/api/auth/jwks",
    resourceUrl: "https://builder.example.test/mcp",
  },
  database: {
    dialect: "postgresql",
    maxConnections: 5,
    migrations: [
      "0001_hosted_eve_bridge",
      "0002_hosted_workspace_membership",
      "0003_hosted_retention_indexes",
      "0004_preview_oauth",
      "0005_github_publication_journal",
    ],
  },
  eve: {
    baseUrl: "https://builder.example.test",
    packageVersion: "0.43.0",
  },
  forwarder: {
    environment: "preview",
    projectName: "autograph-app-builder",
    teamSlug: "withAutograph",
  },
} as const;

describe("hosted Preview receipt boundaries", () => {
  it("is deterministic, closed, and contains no endpoint or provider identity", () => {
    const input = {
      configuration,
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
    };
    const first = buildHostedPreviewSourceConfigurationReceipt(input);
    expect(buildHostedPreviewSourceConfigurationReceipt(input)).toEqual(first);
    expect(first).toMatchObject({
      activation: { status: "not-proven" },
      claims: {
        immediateTokenRevocationClaimed: false,
        liveMembershipCheck: true,
        maximumAccessTokenLifetimeSeconds: 300,
        workspaceSelector: "signed-workspace_id-only",
      },
      evidenceLevel: "source-configuration-only",
      runtime: "hosted-preview",
      secrets: {
        databaseUrlTransport: "runtime-environment-only",
        included: false,
        workloadIdentityTransport: "per-hop-vercel-oidc",
      },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("builder.example.test");
    expect(serialized).not.toContain("withAutograph");
    expect(serialized).not.toContain("autograph-app-builder");
  });

  it("rejects environment, origin, migration, and unknown-key drift", () => {
    for (const drift of [
      {
        ...configuration,
        eve: { ...configuration.eve, baseUrl: "https://other.example.test" },
      },
      {
        ...configuration,
        forwarder: { ...configuration.forwarder, environment: "production" },
      },
      {
        ...configuration,
        database: { ...configuration.database, migrations: [] },
      },
      {
        ...configuration,
        database: {
          ...configuration.database,
          migrations: configuration.database.migrations.slice(0, 3),
        },
      },
      { ...configuration, staticAiGatewayKey: true },
    ]) {
      expect(() =>
        buildHostedPreviewSourceConfigurationReceipt({
          configuration: drift,
          sourceSha: "a".repeat(40),
          sourceTree: "b".repeat(40),
        })
      ).toThrow();
    }
  });

  it("keeps future live activation evidence closed and separate", () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const activation = {
      claims: {
        databaseMigrated: true,
        fiveToolLifecycleVerified: true,
        mintedTokenVerified: true,
        oauthMounted: true,
        productionClaimed: false,
        tenantIsolationVerified: true,
        workloadIdentityVerified: true,
      },
      databaseMigrationReadbackDigest: digest,
      deploymentReadbackDigest: digest,
      environment: "preview",
      evidenceLevel: "live-activation",
      fiveToolLifecycleProofDigest: digest,
      mintedTokenContractDigest: digest,
      oauthMetadataReadbackDigest: digest,
      runtime: "hosted-preview",
      secrets: { included: false },
      sourceConfigurationReceiptDigest: digest,
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      tenantIsolationProofDigest: digest,
      version: 1,
      workloadIdentityProofDigest: digest,
    } as const;
    expect(hostedPreviewActivationReceiptSchema.parse(activation)).toEqual(
      activation
    );
    expect(() =>
      hostedPreviewActivationReceiptSchema.parse({
        ...activation,
        environment: "production",
      })
    ).toThrow();
    expect(() =>
      hostedPreviewActivationReceiptSchema.parse({
        ...activation,
        claims: { ...activation.claims, oauthMounted: false },
      })
    ).toThrow();
  });
});
