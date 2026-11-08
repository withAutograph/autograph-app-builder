import { z } from "zod";

import { builderAppIdSchema } from "./names";

const GITHUB_REPOSITORY_URL_PREFIX = "https://github.com/";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const instant = z.iso.datetime({ offset: true });

export const builderProvisionRequestSchema = z
  .strictObject({
    appName: z.string().trim().min(1).max(120),
    deploymentAccess: z.literal("public-app").optional(),
    operation: z.enum(["github", "vercel"]),
    providers: z.strictObject({
      githubInstallationId: decimal.optional(),
      vercelInstallationId: z.string().min(1).max(256).optional(),
    }),
    repository: z.strictObject({
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9._-]+$/u),
      private: z.boolean(),
    }),
    requestId: z.uuid(),
    version: z.literal(1),
  })
  .superRefine((value, context) => {
    if (value.operation === "github" && value.providers.githubInstallationId === undefined) {
      context.addIssue({
        code: "custom",
        message: "GitHub provisioning requires a selected installation.",
        path: ["providers", "githubInstallationId"],
      });
    }
    if (value.operation === "vercel" && value.providers.vercelInstallationId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Vercel provisioning requires a selected installation.",
        path: ["providers", "vercelInstallationId"],
      });
    }
  });

export type BuilderProvisionRequest = z.infer<typeof builderProvisionRequestSchema>;

/** Bounded Vercel support facts, never a provider message or response body. */
export const vercelProvisionDiagnosticSchema = z.strictObject({
  statusCode: z.number().int().min(400).max(599),
  code: z
    .enum([
      "forbidden",
      "integration_configuration_disabled",
      "not_authorized",
      "insufficient_permissions",
      "project_limit_reached",
      "too_many_projects",
      "invalid_request",
      "bad_request",
      "repo_not_found",
      "rate_limited",
    ])
    .optional(),
  requestRef: z
    .string()
    .max(160)
    .regex(/^[a-z0-9]{3,8}::[A-Za-z0-9_-]{1,120}$/u)
    .optional(),
});
export type VercelProvisionDiagnostic = z.infer<typeof vercelProvisionDiagnosticSchema>;

/** Bounded Vercel support facts, never a provider message or response body. */

const failureSchema = z.strictObject({
  code: z.enum([
    "configuration_unavailable",
    "authorization_required",
    "credential_unavailable",
    "installation_inactive",
    "name_conflict",
    "provider_rejected",
    "provider_permission_denied",
    "provider_validation_failed",
    "provider_quota_exceeded",
    "provider_rate_limited",
    "reconciliation_uncertain",
    "provider_unavailable",
    "source_unavailable",
    "source_mismatch",
    "postcondition_failed",
  ]),
  retryable: z.boolean(),
  providerDiagnostic: vercelProvisionDiagnosticSchema.optional(),
  status: z.literal("failed"),
});

const skippedSchema = z.strictObject({
  code: z.enum(["not_selected", "github_required", "feature_disabled"]),
  retryable: z.boolean(),
  status: z.literal("skipped"),
});

const githubStarterBaseSchema = z.object({
  sourceSha: objectId,
  sourceTree: objectId,
});

const githubClonedStarterSchema = githubStarterBaseSchema
  .extend({
    contractDigest: sha256,
    eligibilityDigest: sha256,
    method: z.literal("git-clone-v1"),
    readinessDigest: sha256,
    receiptVersion: z.literal(4),
    ref: z.literal("refs/heads/main"),
    repository: z.url().startsWith(GITHUB_REPOSITORY_URL_PREFIX),
    sourceReceiptDigest: sha256,
  })
  .strict();

const githubLegacyStarterSchema = githubStarterBaseSchema
  .extend({
    archiveBytes: z.number().int().positive().optional(),
    archiveSha256: sha256.optional(),
    manifestSha256: sha256.optional(),
    method: z.literal("starter-archive-v3").optional(),
    ref: z.literal("refs/heads/main").optional(),
    repository: z.url().startsWith(GITHUB_REPOSITORY_URL_PREFIX).optional(),
  })
  .strict();

export const githubProvisionSuccessSchema = z.strictObject({
  defaultBranch: z.literal("main"),
  fullName: z.string().min(3),
  headSha: objectId,
  headTree: objectId,
  installationId: decimal,
  name: z.string().min(1),
  owner: z.string().min(1),
  repositoryId: decimal,
  scope: z.strictObject({
    id: decimal,
    login: z.string().min(1),
    type: z.enum(["organization", "user"]),
  }),
  starter: z.union([githubClonedStarterSchema, githubLegacyStarterSchema]),
  status: z.literal("succeeded"),
  url: z.url().startsWith(GITHUB_REPOSITORY_URL_PREFIX),
  visibility: z.enum(["public", "private"]),
});

export const vercelProvisionSuccessSchema = z.strictObject({
  dashboardUrl: z.url().startsWith("https://vercel.com/"),
  // Keep historical Next.js app-root receipts readable; new projects use Services.
  framework: z.enum(["services", "nextjs"]),
  installationId: z.string().min(1),
  linkedGitHubRepository: z.string().min(3).optional(),
  name: z.string().min(1),
  projectId: z.string().min(1),
  // Existing journals can describe the retired app-root topology. New
  // provisioning always uses the repository root for native Services.
  rootDirectory: z.union([z.literal("."), z.string().regex(/^apps\/[a-z][a-z0-9-]*$/u)]),
  scope: z.strictObject({
    id: z.string().min(1),
    slug: z.string().min(1),
    type: z.enum(["team", "user"]),
  }),
  status: z.literal("succeeded"),
});

export const githubProvisionResultSchema = z.union([
  githubProvisionSuccessSchema,
  failureSchema,
  skippedSchema,
]);
export const vercelProvisionResultSchema = z.union([
  vercelProvisionSuccessSchema,
  failureSchema,
  skippedSchema,
]);

export const builderProvisionResponseSchema = z.strictObject({
  appId: builderAppIdSchema,
  deploymentAccess: z.literal("public-app").optional(),
  diagnostics: z
    .array(
      z.strictObject({
        code: z.string().min(1),
        nextRetryAt: instant.optional(),
        operation: z.enum(["github", "vercel"]),
        outcomeKnown: z.boolean(),
        provider: z.enum(["github", "vercel"]),
        lastProviderDiagnostic: vercelProvisionDiagnosticSchema.optional(),

        recoveryAction: z.string().min(1),
      }),
    )
    .optional(),
  github: githubProvisionResultSchema,
  requestDigest: sha256,
  requestId: z.uuid(),
  status: z.enum(["pending", "settled"]),
  updatedAt: instant,
  vercel: vercelProvisionResultSchema,
  version: z.literal(1),
});

export type BuilderProvisionResponse = z.infer<typeof builderProvisionResponseSchema>;

/**
 * The authenticated, durable journal read model used by route consumers and
 * SSE. `revision` belongs to the journal row rather than the provider payload,
 * which keeps it monotonic even when provider timestamps have limited clock
 * precision.
 */
export const builderProvisionProjectionSchema = z.strictObject({
  provisioning: builderProvisionResponseSchema,
  revision: z.number().int().positive(),
});

export type BuilderProvisionProjection = z.infer<typeof builderProvisionProjectionSchema>;
export type GitHubProvisionResult = z.infer<typeof githubProvisionResultSchema>;
export type VercelProvisionResult = z.infer<typeof vercelProvisionResultSchema>;
