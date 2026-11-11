import { z } from "zod";
import { builderAppIdSchema } from "./names";

const unavailable = "service-unavailable";
const publicAppUrl = z.url().refine((value) => {
  const url = new URL(value);
  const publicHost =
    url.hostname !== "vercel-infra.com" && !url.hostname.endsWith(".vercel-infra.com");
  return url.protocol === "https:" && url.username === "" && url.password === "" && publicHost;
}, "The app entry must use its public HTTPS origin without credentials");

/** Observation only: current app availability never qualifies a newly merged revision. */
export const repositoryProductionNativeStatusSchema = z.strictObject({
  version: z.literal(1),
  appId: builderAppIdSchema,
  observedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["available", "pending", unavailable]),
  destination: z
    .strictObject({
      repositoryId: z.string().min(1),
      repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    })
    .optional(),
  deployment: z.strictObject({
    state: z.enum(["active", "not-observed", unavailable]),
  }),
  app: z.strictObject({
    state: z.enum(["responding", "sign-in-required", "registered", "not-observed", unavailable]),
    url: publicAppUrl.optional(),
  }),
  requestedRevision: z.literal("unassessed"),
  serviceIssue: z
    .enum(["configuration", "provider-access", "provider-read", "domain-binding", "gateway-read"])
    .optional(),
});

export type RepositoryProductionNativeStatus = z.infer<
  typeof repositoryProductionNativeStatusSchema
>;
