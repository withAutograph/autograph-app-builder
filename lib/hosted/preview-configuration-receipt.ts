import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedMcpAuthConfigSchema } from "../mcp/request-auth";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const previewForwarderSchema = z
  .object({
    environment: z.literal("preview"),
    projectName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/u),
    teamSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();

const hostedPreviewConfigurationSchema = z
  .object({
    auth: hostedMcpAuthConfigSchema,
    database: z
      .object({
        dialect: z.literal("postgresql"),
        maxConnections: z.literal(5),
        migrations: z.tuple([
          z.literal("0001_hosted_eve_bridge"),
          z.literal("0002_hosted_workspace_membership"),
          z.literal("0003_hosted_retention_indexes"),
          z.literal("0004_preview_oauth"),
          z.literal("0005_github_publication_journal"),
        ]),
      })
      .strict(),
    eve: z
      .object({
        baseUrl: z.string().url().startsWith("https://"),
        packageVersion: z.literal("0.43.0"),
      })
      .strict(),
    forwarder: previewForwarderSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (new URL(config.auth.resourceUrl).origin !== config.eve.baseUrl) {
      context.addIssue({
        code: "custom",
        message: "Canonical Eve and MCP must share one exact origin.",
        path: ["eve", "baseUrl"],
      });
    }
  });

export const hostedPreviewSourceConfigurationReceiptSchema = z
  .object({
    activation: z.object({ status: z.literal("not-proven") }).strict(),
    authContractDigest: sha256Schema,
    claims: z
      .object({
        workspaceSelector: z.literal("signed-workspace_id-only"),
        maximumAccessTokenLifetimeSeconds: z.literal(300),
        liveMembershipCheck: z.literal(true),
        immediateTokenRevocationClaimed: z.literal(false),
      })
      .strict(),
    configurationDigest: sha256Schema,
    databaseContractDigest: sha256Schema,
    evidenceLevel: z.literal("source-configuration-only"),
    forwarderContractDigest: sha256Schema,
    runtime: z.literal("hosted-preview"),
    sameOriginContractDigest: sha256Schema,
    secrets: z
      .object({
        included: z.literal(false),
        databaseUrlTransport: z.literal("runtime-environment-only"),
        workloadIdentityTransport: z.literal("per-hop-vercel-oidc"),
      })
      .strict(),
    sourceSha: gitObjectSchema,
    sourceTree: gitObjectSchema,
    version: z.literal(1),
  })
  .strict();

export type HostedPreviewSourceConfigurationReceipt = z.infer<
  typeof hostedPreviewSourceConfigurationReceiptSchema
>;

export const hostedPreviewActivationReceiptSchema = z
  .object({
    claims: z
      .object({
        oauthMounted: z.literal(true),
        databaseMigrated: z.literal(true),
        mintedTokenVerified: z.literal(true),
        workloadIdentityVerified: z.literal(true),
        tenantIsolationVerified: z.literal(true),
        fiveToolLifecycleVerified: z.literal(true),
        productionClaimed: z.literal(false),
      })
      .strict(),
    databaseMigrationReadbackDigest: sha256Schema,
    deploymentReadbackDigest: sha256Schema,
    environment: z.literal("preview"),
    evidenceLevel: z.literal("live-activation"),
    fiveToolLifecycleProofDigest: sha256Schema,
    mintedTokenContractDigest: sha256Schema,
    oauthMetadataReadbackDigest: sha256Schema,
    runtime: z.literal("hosted-preview"),
    secrets: z.object({ included: z.literal(false) }).strict(),
    sourceConfigurationReceiptDigest: sha256Schema,
    sourceSha: gitObjectSchema,
    sourceTree: gitObjectSchema,
    tenantIsolationProofDigest: sha256Schema,
    version: z.literal(1),
    workloadIdentityProofDigest: sha256Schema,
  })
  .strict();

export type HostedPreviewActivationReceipt = z.infer<
  typeof hostedPreviewActivationReceiptSchema
>;

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

export function buildHostedPreviewSourceConfigurationReceipt(input: {
  sourceSha: string;
  sourceTree: string;
  configuration: unknown;
}): HostedPreviewSourceConfigurationReceipt {
  const configuration = hostedPreviewConfigurationSchema.parse(
    input.configuration
  );
  return hostedPreviewSourceConfigurationReceiptSchema.parse({
    activation: { status: "not-proven" },
    authContractDigest: digest(configuration.auth),
    claims: {
      immediateTokenRevocationClaimed: false,
      liveMembershipCheck: true,
      maximumAccessTokenLifetimeSeconds: 300,
      workspaceSelector: "signed-workspace_id-only",
    },
    configurationDigest: digest(configuration),
    databaseContractDigest: digest(configuration.database),
    evidenceLevel: "source-configuration-only",
    forwarderContractDigest: digest(configuration.forwarder),
    runtime: "hosted-preview",
    sameOriginContractDigest: digest({
      resourceOrigin: new URL(configuration.auth.resourceUrl).origin,
      eveBaseUrl: configuration.eve.baseUrl,
    }),
    secrets: {
      databaseUrlTransport: "runtime-environment-only",
      included: false,
      workloadIdentityTransport: "per-hop-vercel-oidc",
    },
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    version: 1,
  });
}
