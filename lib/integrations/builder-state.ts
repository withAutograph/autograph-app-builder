import { z } from "zod";

import { providerConnectionFailureReasonSchema } from "./provider-connection-status";

export const builderVercelScopeSchema = z.strictObject({
  displayName: z.string().min(1),
  installationId: z.string().min(1),
  plan: z.string().min(1),
  slug: z.string().min(1),
  status: z.literal("connected"),
});

export const builderGitHubScopeSchema = z.strictObject({
  accountLogin: z.string().min(1),
  accountType: z.enum(["Organization", "User"]),
  installationId: z.string().regex(/^[1-9][0-9]*$/u),
  status: z.literal("connected"),
});

export const builderModelSchema = z.strictObject({
  capabilities: z.array(z.string().min(1)).max(64),
  id: z.string().min(3),
  name: z.string().min(1),
  provider: z.string().min(1),
  zdr: z.enum(["all", "some", "none"]),
});

export const builderIntegrationStateSchema = z.strictObject({
  github: z
    .strictObject({
      scopes: z.array(builderGitHubScopeSchema).max(100),
      status: z.enum(["connected", "disconnected", "unavailable"]),
      unavailableReason: providerConnectionFailureReasonSchema.optional(),
    })
    .superRefine((value, context) => {
      if ((value.status === "unavailable") !== (value.unavailableReason !== undefined)) {
        context.addIssue({
          code: "custom",
          message: "Unavailable GitHub state requires exactly one failure reason.",
          path: ["unavailableReason"],
        });
      }
    }),
  models: z.strictObject({
    cached: z.boolean(),
    defaultModelId: z.string().min(3).optional(),
    entries: z.array(builderModelSchema).max(1000),
    status: z.enum(["ready", "unavailable"]),
  }),
  vercel: z
    .strictObject({
      scopes: z.array(builderVercelScopeSchema).max(100),
      status: z.enum(["connected", "disconnected", "unavailable"]),
      unavailableReason: providerConnectionFailureReasonSchema.optional(),
    })
    .superRefine((value, context) => {
      if ((value.status === "unavailable") !== (value.unavailableReason !== undefined)) {
        context.addIssue({
          code: "custom",
          message: "Unavailable Vercel state requires exactly one failure reason.",
          path: ["unavailableReason"],
        });
      }
    }),
});

export type BuilderIntegrationState = z.infer<typeof builderIntegrationStateSchema>;

export const disconnectedBuilderIntegrationState: BuilderIntegrationState = {
  github: { scopes: [], status: "disconnected" },
  models: { cached: false, entries: [], status: "unavailable" },
  vercel: { scopes: [], status: "disconnected" },
};
