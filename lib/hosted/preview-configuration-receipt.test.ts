import { describe, expect, it } from "vitest";

import {
  buildHostedPreviewSourceConfigurationReceipt,
  hostedPreviewActivationReceiptSchema,
} from "./preview-configuration-receipt";

const configuration = {
  auth: {
    issuer: "https://builder.example.test/api/auth",
    audience: "https://builder.example.test/mcp",
    jwksUrl: "https://builder.example.test/api/auth/jwks",
    algorithm: "ES256",
    resourceUrl: "https://builder.example.test/mcp",
  },
  forwarder: {
    teamSlug: "withAutograph",
    projectName: "autograph-app-builder",
    environment: "preview",
  },
  eve: {
    baseUrl: "https://builder.example.test",
    packageVersion: "0.43.0",
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
  admissionControl: {
    version: 1,
    environment: "preview",
    enforcement: "provider-readback",
    scope: "issuer-audience-workspace-subject",
    startsPerSubjectPerMinute: 10,
    startsPerWorkspacePerMinute: 50,
    maxConcurrentSessionsPerSubject: 2,
    maxActiveSessionsPerWorkspace: 20,
    monthlySpendUsedUsdCents: 0,
    monthlySpendLimitUsdCents: 10_000,
    observedAt: "2026-08-27T00:55:00.000Z",
    expiresAt: "2026-08-27T01:55:00.000Z",
    readbackDigest: `sha256:${"c".repeat(64)}`,
  },
} as const;

describe("hosted Preview receipt boundaries", () => {
  it("is deterministic, closed, and contains no endpoint or provider identity", () => {
    const input = {
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      configuration,
    };
    const first = buildHostedPreviewSourceConfigurationReceipt(input);
    expect(buildHostedPreviewSourceConfigurationReceipt(input)).toEqual(first);
    expect(first).toMatchObject({
      runtime: "hosted-preview",
      evidenceLevel: "source-configuration-only",
      activation: { status: "not-proven" },
      claims: {
        workspaceSelector: "signed-workspace_id-only",
        maximumAccessTokenLifetimeSeconds: 300,
        liveMembershipCheck: true,
        immediateTokenRevocationClaimed: false,
      },
      secrets: {
        included: false,
        databaseUrlTransport: "runtime-environment-only",
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
          sourceSha: "a".repeat(40),
          sourceTree: "b".repeat(40),
          configuration: drift,
        }),
      ).toThrow();
    }
  });

  it("keeps future live activation evidence closed and separate", () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const activation = {
      version: 1,
      runtime: "hosted-preview",
      evidenceLevel: "live-activation",
      environment: "preview",
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      sourceConfigurationReceiptDigest: digest,
      deploymentReadbackDigest: digest,
      oauthMetadataReadbackDigest: digest,
      mintedTokenContractDigest: digest,
      databaseMigrationReadbackDigest: digest,
      admissionControlReadbackDigest: digest,
      workloadIdentityProofDigest: digest,
      tenantIsolationProofDigest: digest,
      fiveToolLifecycleProofDigest: digest,
      claims: {
        oauthMounted: true,
        databaseMigrated: true,
        mintedTokenVerified: true,
        admissionControlVerified: true,
        workloadIdentityVerified: true,
        tenantIsolationVerified: true,
        fiveToolLifecycleVerified: true,
        productionClaimed: false,
      },
      secrets: { included: false },
    } as const;
    expect(hostedPreviewActivationReceiptSchema.parse(activation)).toEqual(
      activation,
    );
    expect(() =>
      hostedPreviewActivationReceiptSchema.parse({
        ...activation,
        environment: "production",
      }),
    ).toThrow();
    expect(() =>
      hostedPreviewActivationReceiptSchema.parse({
        ...activation,
        claims: { ...activation.claims, oauthMounted: false },
      }),
    ).toThrow();
  });
});
