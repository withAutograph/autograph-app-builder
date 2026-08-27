import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedMcpAuthConfigSchema } from "../mcp/request-auth";
import { hostedPreviewAdmissionControlBindingSchema } from "./admission-control";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const previewForwarderSchema = z
  .object({
    teamSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/u),
    projectName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/u),
    environment: z.literal("preview"),
  })
  .strict();

const hostedPreviewConfigurationSchema = z
  .object({
    auth: hostedMcpAuthConfigSchema,
    forwarder: previewForwarderSchema,
    eve: z
      .object({
        baseUrl: z.string().url().startsWith("https://"),
        packageVersion: z.literal("0.43.0"),
      })
      .strict(),
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
    admissionControl: hostedPreviewAdmissionControlBindingSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (new URL(config.auth.resourceUrl).origin !== config.eve.baseUrl) {
      context.addIssue({
        code: "custom",
        path: ["eve", "baseUrl"],
        message: "Canonical Eve and MCP must share one exact origin.",
      });
    }
  });

export const hostedPreviewSourceConfigurationReceiptSchema = z
  .object({
    version: z.literal(1),
    runtime: z.literal("hosted-preview"),
    evidenceLevel: z.literal("source-configuration-only"),
    sourceSha: gitObjectSchema,
    sourceTree: gitObjectSchema,
    configurationDigest: sha256Schema,
    authContractDigest: sha256Schema,
    forwarderContractDigest: sha256Schema,
    databaseContractDigest: sha256Schema,
    sameOriginContractDigest: sha256Schema,
    admissionControlContractDigest: sha256Schema,
    claims: z
      .object({
        workspaceSelector: z.literal("signed-workspace_id-only"),
        maximumAccessTokenLifetimeSeconds: z.literal(300),
        liveMembershipCheck: z.literal(true),
        immediateTokenRevocationClaimed: z.literal(false),
      })
      .strict(),
    secrets: z
      .object({
        included: z.literal(false),
        databaseUrlTransport: z.literal("runtime-environment-only"),
        workloadIdentityTransport: z.literal("per-hop-vercel-oidc"),
      })
      .strict(),
    activation: z.object({ status: z.literal("not-proven") }).strict(),
  })
  .strict();

export type HostedPreviewSourceConfigurationReceipt = z.infer<
  typeof hostedPreviewSourceConfigurationReceiptSchema
>;

export const hostedPreviewActivationReceiptSchema = z
  .object({
    version: z.literal(1),
    runtime: z.literal("hosted-preview"),
    evidenceLevel: z.literal("live-activation"),
    environment: z.literal("preview"),
    sourceSha: gitObjectSchema,
    sourceTree: gitObjectSchema,
    sourceConfigurationReceiptDigest: sha256Schema,
    deploymentReadbackDigest: sha256Schema,
    oauthMetadataReadbackDigest: sha256Schema,
    mintedTokenContractDigest: sha256Schema,
    databaseMigrationReadbackDigest: sha256Schema,
    admissionControlReadbackDigest: sha256Schema,
    workloadIdentityProofDigest: sha256Schema,
    tenantIsolationProofDigest: sha256Schema,
    fiveToolLifecycleProofDigest: sha256Schema,
    claims: z
      .object({
        oauthMounted: z.literal(true),
        databaseMigrated: z.literal(true),
        mintedTokenVerified: z.literal(true),
        admissionControlVerified: z.literal(true),
        workloadIdentityVerified: z.literal(true),
        tenantIsolationVerified: z.literal(true),
        fiveToolLifecycleVerified: z.literal(true),
        productionClaimed: z.literal(false),
      })
      .strict(),
    secrets: z.object({ included: z.literal(false) }).strict(),
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
    input.configuration,
  );
  return hostedPreviewSourceConfigurationReceiptSchema.parse({
    version: 1,
    runtime: "hosted-preview",
    evidenceLevel: "source-configuration-only",
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    configurationDigest: digest(configuration),
    authContractDigest: digest(configuration.auth),
    forwarderContractDigest: digest(configuration.forwarder),
    databaseContractDigest: digest(configuration.database),
    sameOriginContractDigest: digest({
      resourceOrigin: new URL(configuration.auth.resourceUrl).origin,
      eveBaseUrl: configuration.eve.baseUrl,
    }),
    admissionControlContractDigest: digest(configuration.admissionControl),
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
    activation: { status: "not-proven" },
  });
}
