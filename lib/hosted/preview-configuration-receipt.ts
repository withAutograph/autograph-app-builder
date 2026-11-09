import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedMcpAuthConfigSchema } from "../mcp/request-auth";

const hostedPreviewRuntime = "hosted-preview";
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const previewForwarderSchema = z.strictObject({
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
});

const hostedPreviewConfigurationSchema = z
  .strictObject({
    auth: hostedMcpAuthConfigSchema,
    database: z.strictObject({
      dialect: z.literal("postgresql"),
      maxConnections: z.literal(5),
      migrations: z.tuple([
        z.literal("0001_hosted_eve_bridge"),
        z.literal("0002_hosted_workspace_membership"),
        z.literal("0003_hosted_retention_indexes"),
        z.literal("0004_preview_oauth"),
        z.literal("0005_github_publication_journal"),
      ]),
    }),
    eve: z.strictObject({
      baseUrl: z.url().startsWith("https://"),
      packageVersion: z.literal("0.43.0"),
    }),
    forwarder: previewForwarderSchema,
  })
  .superRefine((config, context) => {
    if (new URL(config.auth.resourceUrl).origin !== config.eve.baseUrl) {
      context.addIssue({
        code: "custom",
        message: "Canonical Eve and MCP must share one exact origin.",
        path: ["eve", "baseUrl"],
      });
    }
  });

export const hostedPreviewSourceConfigurationReceiptSchema = z.strictObject({
  activation: z.strictObject({ status: z.literal("not-proven") }),
  authContractDigest: sha256Schema,
  claims: z.strictObject({
    immediateTokenRevocationClaimed: z.literal(false),
    liveMembershipCheck: z.literal(true),
    maximumAccessTokenLifetimeSeconds: z.literal(300),
    workspaceSelector: z.literal("signed-workspace_id-only"),
  }),
  configurationDigest: sha256Schema,
  databaseContractDigest: sha256Schema,
  evidenceLevel: z.literal("source-configuration-only"),
  forwarderContractDigest: sha256Schema,
  runtime: z.literal(hostedPreviewRuntime),
  sameOriginContractDigest: sha256Schema,
  secrets: z.strictObject({
    databaseUrlTransport: z.literal("runtime-environment-only"),
    included: z.literal(false),
    workloadIdentityTransport: z.literal("per-hop-vercel-oidc"),
  }),
  sourceSha: gitObjectSchema,
  sourceTree: gitObjectSchema,
  version: z.literal(1),
});

export type HostedPreviewSourceConfigurationReceipt = z.infer<
  typeof hostedPreviewSourceConfigurationReceiptSchema
>;

export const hostedPreviewActivationReceiptSchema = z.strictObject({
  claims: z.strictObject({
    databaseMigrated: z.literal(true),
    fiveToolLifecycleVerified: z.literal(true),
    mintedTokenVerified: z.literal(true),
    oauthMounted: z.literal(true),
    productionClaimed: z.literal(false),
    tenantIsolationVerified: z.literal(true),
    workloadIdentityVerified: z.literal(true),
  }),
  databaseMigrationReadbackDigest: sha256Schema,
  deploymentReadbackDigest: sha256Schema,
  environment: z.literal("preview"),
  evidenceLevel: z.literal("live-activation"),
  fiveToolLifecycleProofDigest: sha256Schema,
  mintedTokenContractDigest: sha256Schema,
  oauthMetadataReadbackDigest: sha256Schema,
  runtime: z.literal(hostedPreviewRuntime),
  secrets: z.strictObject({ included: z.literal(false) }),
  sourceConfigurationReceiptDigest: sha256Schema,
  sourceSha: gitObjectSchema,
  sourceTree: gitObjectSchema,
  tenantIsolationProofDigest: sha256Schema,
  version: z.literal(1),
  workloadIdentityProofDigest: sha256Schema,
});

export type HostedPreviewActivationReceipt = z.infer<typeof hostedPreviewActivationReceiptSchema>;

// oxlint-disable-next-line eslint/func-style, anti-slop/no-unknown-parameters -- Preserve function declaration hoisting and initialization timing. Preserve the existing unknown input contract.
function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildHostedPreviewSourceConfigurationReceipt(input: {
  sourceSha: string;
  sourceTree: string;
  configuration: unknown;
}): HostedPreviewSourceConfigurationReceipt {
  const configuration = hostedPreviewConfigurationSchema.parse(input.configuration);
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
    runtime: hostedPreviewRuntime,
    sameOriginContractDigest: digest({
      eveBaseUrl: configuration.eve.baseUrl,
      resourceOrigin: new URL(configuration.auth.resourceUrl).origin,
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
