import { z } from "zod";

export const builderVercelScopeSchema = z
  .object({
    installationId: z.string().min(1),
    status: z.literal("connected"),
    displayName: z.string().min(1),
    slug: z.string().min(1),
    plan: z.string().min(1),
  })
  .strict();

export const builderGitHubScopeSchema = z
  .object({
    installationId: z.string().regex(/^[1-9][0-9]*$/u),
    status: z.literal("connected"),
    accountLogin: z.string().min(1),
    accountType: z.enum(["Organization", "User"]),
  })
  .strict();

export const builderModelSchema = z
  .object({
    id: z.string().min(3),
    name: z.string().min(1),
    provider: z.string().min(1),
    capabilities: z.array(z.string().min(1)).max(64),
    zdr: z.enum(["all", "some", "none"]),
  })
  .strict();

export const builderIntegrationStateSchema = z
  .object({
    vercel: z
      .object({
        status: z.enum(["connected", "disconnected", "unavailable"]),
        scopes: z.array(builderVercelScopeSchema).max(100),
      })
      .strict(),
    github: z
      .object({
        status: z.enum(["connected", "disconnected", "unavailable"]),
        scopes: z.array(builderGitHubScopeSchema).max(100),
      })
      .strict(),
    models: z
      .object({
        status: z.enum(["ready", "unavailable"]),
        entries: z.array(builderModelSchema).max(1_000),
        defaultModelId: z.string().min(3).optional(),
        cached: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type BuilderIntegrationState = z.infer<
  typeof builderIntegrationStateSchema
>;

export const disconnectedBuilderIntegrationState: BuilderIntegrationState = {
  vercel: { status: "disconnected", scopes: [] },
  github: { status: "disconnected", scopes: [] },
  models: { status: "unavailable", entries: [], cached: false },
};
