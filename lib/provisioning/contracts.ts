import { createHash } from "node:crypto";

import { z } from "zod";

import { builderAppIdSchema, deriveBuilderAppId } from "./names";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const instant = z.string().datetime({ offset: true });

export const builderProvisionRequestSchema = z
  .object({
    appName: z.string().trim().min(1).max(120),
    operation: z.enum(["github", "vercel"]),
    providers: z
      .object({
        githubInstallationId: decimal.optional(),
        vercelInstallationId: z.string().min(1).max(256).optional(),
      })
      .strict(),
    repository: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/u),
        private: z.boolean(),
      })
      .strict(),
    requestId: z.string().uuid(),
    version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.operation === "github" &&
      value.providers.githubInstallationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "GitHub provisioning requires a selected installation.",
        path: ["providers", "githubInstallationId"],
      });
    }
    if (
      value.operation === "vercel" &&
      value.providers.vercelInstallationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Vercel provisioning requires a selected installation.",
        path: ["providers", "vercelInstallationId"],
      });
    }
  });

export type BuilderProvisionRequest = z.infer<
  typeof builderProvisionRequestSchema
>;

const failureSchema = z
  .object({
    code: z.enum([
      "configuration_unavailable",
      "credential_unavailable",
      "installation_inactive",
      "name_conflict",
      "provider_rejected",
      "provider_unavailable",
      "source_unavailable",
      "source_mismatch",
      "postcondition_failed",
    ]),
    retryable: z.boolean(),
    status: z.literal("failed"),
  })
  .strict();

const skippedSchema = z
  .object({
    code: z.enum(["not_selected", "github_required", "feature_disabled"]),
    retryable: z.boolean(),
    status: z.literal("skipped"),
  })
  .strict();

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
    repository: z.string().url().startsWith("https://github.com/"),
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
    repository: z.string().url().startsWith("https://github.com/").optional(),
  })
  .strict();

export const githubProvisionSuccessSchema = z
  .object({
    defaultBranch: z.literal("main"),
    fullName: z.string().min(3),
    headSha: objectId,
    headTree: objectId,
    installationId: decimal,
    name: z.string().min(1),
    owner: z.string().min(1),
    repositoryId: decimal,
    scope: z
      .object({
        type: z.enum(["organization", "user"]),
        id: decimal,
        login: z.string().min(1),
      })
      .strict(),
    starter: z.union([githubClonedStarterSchema, githubLegacyStarterSchema]),
    status: z.literal("succeeded"),
    url: z.string().url().startsWith("https://github.com/"),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

export const vercelProvisionSuccessSchema = z
  .object({
    dashboardUrl: z.string().url().startsWith("https://vercel.com/"),
    framework: z.literal("nextjs"),
    installationId: z.string().min(1),
    linkedGitHubRepository: z.string().min(3).optional(),
    name: z.string().min(1),
    projectId: z.string().min(1),
    rootDirectory: z.string().regex(/^apps\/[a-z][a-z0-9-]*$/u),
    scope: z
      .object({
        type: z.enum(["team", "user"]),
        id: z.string().min(1),
        slug: z.string().min(1),
      })
      .strict(),
    status: z.literal("succeeded"),
  })
  .strict();

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

export const builderProvisionResponseSchema = z
  .object({
    appId: builderAppIdSchema,
    github: githubProvisionResultSchema,
    requestDigest: sha256,
    requestId: z.string().uuid(),
    status: z.enum(["pending", "settled"]),
    updatedAt: instant,
    vercel: vercelProvisionResultSchema,
    version: z.literal(1),
  })
  .strict();

export type BuilderProvisionResponse = z.infer<
  typeof builderProvisionResponseSchema
>;
export type GitHubProvisionResult = z.infer<typeof githubProvisionResultSchema>;
export type VercelProvisionResult = z.infer<typeof vercelProvisionResultSchema>;

export function builderProvisionRequestDigest(
  input: BuilderProvisionRequest
): string {
  const request = builderProvisionRequestSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        appName: request.appName,
        providers: request.providers,
        repository: request.repository,
        requestId: request.requestId,
        version: request.version,
      })
    )
    .digest("hex");
}

export function initialBuilderProvisionResponse(
  input: BuilderProvisionRequest,
  now = new Date()
): BuilderProvisionResponse {
  const request = builderProvisionRequestSchema.parse(input);
  return builderProvisionResponseSchema.parse({
    appId: deriveBuilderAppId(request.appName),
    github: request.providers.githubInstallationId
      ? { status: "failed", code: "provider_unavailable", retryable: true }
      : { status: "skipped", code: "not_selected", retryable: false },
    requestDigest: builderProvisionRequestDigest(request),
    requestId: request.requestId,
    status: "pending",
    updatedAt: now.toISOString(),
    vercel: request.providers.vercelInstallationId
      ? { status: "failed", code: "provider_unavailable", retryable: true }
      : { status: "skipped", code: "not_selected", retryable: false },
    version: 1,
  });
}
