import { createHash } from "node:crypto";

import { z } from "zod";

import { builderAppIdSchema, deriveBuilderAppId } from "./names";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const instant = z.string().datetime({ offset: true });

export const builderProvisionRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    operation: z.enum(["github", "vercel"]),
    appName: z.string().trim().min(1).max(120),
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
    providers: z
      .object({
        githubInstallationId: decimal.optional(),
        vercelInstallationId: z.string().min(1).max(256).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.operation === "github" &&
      value.providers.githubInstallationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["providers", "githubInstallationId"],
        message: "GitHub provisioning requires a selected installation.",
      });
    }
    if (
      value.operation === "vercel" &&
      value.providers.vercelInstallationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["providers", "vercelInstallationId"],
        message: "Vercel provisioning requires a selected installation.",
      });
    }
  });

export type BuilderProvisionRequest = z.infer<
  typeof builderProvisionRequestSchema
>;

const failureSchema = z
  .object({
    status: z.literal("failed"),
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
  })
  .strict();

const skippedSchema = z
  .object({
    status: z.literal("skipped"),
    code: z.enum(["not_selected", "github_required", "feature_disabled"]),
    retryable: z.boolean(),
  })
  .strict();

const githubStarterBaseSchema = z.object({
  sourceSha: objectId,
  sourceTree: objectId,
});

const githubClonedStarterSchema = githubStarterBaseSchema
  .extend({
    repository: z.string().url().startsWith("https://github.com/"),
    ref: z.literal("refs/heads/main"),
    method: z.literal("git-clone-v1"),
    readinessDigest: sha256,
    receiptVersion: z.literal(4),
    sourceReceiptDigest: sha256,
    eligibilityDigest: sha256,
    contractDigest: sha256,
  })
  .strict();

const githubLegacyStarterSchema = githubStarterBaseSchema
  .extend({
    repository: z.string().url().startsWith("https://github.com/").optional(),
    ref: z.literal("refs/heads/main").optional(),
    method: z.literal("starter-archive-v3").optional(),
    archiveSha256: sha256.optional(),
    archiveBytes: z.number().int().positive().optional(),
    manifestSha256: sha256.optional(),
  })
  .strict();

export const githubProvisionSuccessSchema = z
  .object({
    status: z.literal("succeeded"),
    installationId: decimal,
    repositoryId: decimal,
    owner: z.string().min(1),
    name: z.string().min(1),
    fullName: z.string().min(3),
    url: z.string().url().startsWith("https://github.com/"),
    scope: z
      .object({
        type: z.enum(["organization", "user"]),
        id: decimal,
        login: z.string().min(1),
      })
      .strict(),
    visibility: z.enum(["public", "private"]),
    defaultBranch: z.literal("main"),
    headSha: objectId,
    headTree: objectId,
    starter: z.union([githubClonedStarterSchema, githubLegacyStarterSchema]),
  })
  .strict();

export const vercelProvisionSuccessSchema = z
  .object({
    status: z.literal("succeeded"),
    installationId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    dashboardUrl: z.string().url().startsWith("https://vercel.com/"),
    scope: z
      .object({
        type: z.enum(["team", "user"]),
        id: z.string().min(1),
        slug: z.string().min(1),
      })
      .strict(),
    framework: z.literal("nextjs"),
    rootDirectory: z.string().regex(/^apps\/[a-z][a-z0-9-]*$/u),
    linkedGitHubRepository: z.string().min(3).optional(),
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
    version: z.literal(1),
    requestId: z.string().uuid(),
    requestDigest: sha256,
    appId: builderAppIdSchema,
    status: z.enum(["pending", "settled"]),
    github: githubProvisionResultSchema,
    vercel: vercelProvisionResultSchema,
    updatedAt: instant,
  })
  .strict();

export type BuilderProvisionResponse = z.infer<
  typeof builderProvisionResponseSchema
>;
export type GitHubProvisionResult = z.infer<typeof githubProvisionResultSchema>;
export type VercelProvisionResult = z.infer<typeof vercelProvisionResultSchema>;

export function builderProvisionRequestDigest(
  input: BuilderProvisionRequest,
): string {
  const request = builderProvisionRequestSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: request.version,
        requestId: request.requestId,
        appName: request.appName,
        repository: request.repository,
        providers: request.providers,
      }),
    )
    .digest("hex");
}

export function initialBuilderProvisionResponse(
  input: BuilderProvisionRequest,
  now = new Date(),
): BuilderProvisionResponse {
  const request = builderProvisionRequestSchema.parse(input);
  return builderProvisionResponseSchema.parse({
    version: 1,
    requestId: request.requestId,
    requestDigest: builderProvisionRequestDigest(request),
    appId: deriveBuilderAppId(request.appName),
    status: "pending",
    github: request.providers.githubInstallationId
      ? { status: "failed", code: "provider_unavailable", retryable: true }
      : { status: "skipped", code: "not_selected", retryable: false },
    vercel: request.providers.vercelInstallationId
      ? { status: "failed", code: "provider_unavailable", retryable: true }
      : { status: "skipped", code: "not_selected", retryable: false },
    updatedAt: now.toISOString(),
  });
}
