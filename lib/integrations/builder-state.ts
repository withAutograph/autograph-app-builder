import { z } from "zod";

import { providerConnectionFailureReasonSchema } from "./provider-connection-status";

export const builderVercelScopeSchema = z
  .object({
    displayName: z.string().min(1),
    installationId: z.string().min(1),
    plan: z.string().min(1),
    slug: z.string().min(1),
    status: z.literal("connected"),
  })
  .strict();

export const builderGitHubScopeSchema = z
  .object({
    accountLogin: z.string().min(1),
    accountType: z.enum(["Organization", "User"]),
    installationId: z.string().regex(/^[1-9][0-9]*$/u),
    status: z.literal("connected"),
  })
  .strict();

export const builderModelSchema = z
  .object({
    capabilities: z.array(z.string().min(1)).max(64),
    id: z.string().min(3),
    name: z.string().min(1),
    provider: z.string().min(1),
    zdr: z.enum(["all", "some", "none"]),
  })
  .strict();

export const builderIntegrationStateSchema = z
  .object({
    github: z
      .object({
        status: z.enum(["connected", "disconnected", "unavailable"]),
        scopes: z.array(builderGitHubScopeSchema).max(100),
        unavailableReason: providerConnectionFailureReasonSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          (value.status === "unavailable") !==
          (value.unavailableReason !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: ["unavailableReason"],
            message:
              "Unavailable GitHub state requires exactly one failure reason.",
          });
        }
      }),
    models: z
      .object({
        status: z.enum(["ready", "unavailable"]),
        entries: z.array(builderModelSchema).max(1_000),
        defaultModelId: z.string().min(3).optional(),
        cached: z.boolean(),
      })
      .strict(),
    vercel: z
      .object({
        status: z.enum(["connected", "disconnected", "unavailable"]),
        scopes: z.array(builderVercelScopeSchema).max(100),
        unavailableReason: providerConnectionFailureReasonSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          (value.status === "unavailable") !==
          (value.unavailableReason !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: ["unavailableReason"],
            message:
              "Unavailable Vercel state requires exactly one failure reason.",
          });
        }
      }),
  })
  .strict();

export type BuilderIntegrationState = z.infer<
  typeof builderIntegrationStateSchema
>;

export const disconnectedBuilderIntegrationState: BuilderIntegrationState = {
  github: { scopes: [], status: "disconnected" },
  models: { cached: false, entries: [], status: "unavailable" },
  vercel: { scopes: [], status: "disconnected" },
};
