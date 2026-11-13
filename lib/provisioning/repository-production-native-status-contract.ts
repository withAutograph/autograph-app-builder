import { z } from "zod";
import { builderAppIdSchema } from "./names";

const unavailable = "service-unavailable";
const publicAppUrl = z.url().refine((value) => {
  const url = new URL(value);
  const publicHost =
    url.hostname !== "vercel-infra.com" && !url.hostname.endsWith(".vercel-infra.com");
  return url.protocol === "https:" && url.username === "" && url.password === "" && publicHost;
}, "The app entry must use its public HTTPS origin without credentials");

export const repositoryProductionExpectedMergeShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
export const repositoryProductionSchemaGrantDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Current app availability and activation of an expected merge are independent observations. */
export const repositoryProductionNativeStatusSchema = z
  .strictObject({
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
    deployment: z
      .strictObject({
        state: z.enum(["active", "not-observed", unavailable]),
        requestedRevisionActive: z.literal(true).optional(),
      })
      .refine(
        ({ state, requestedRevisionActive }) =>
          requestedRevisionActive !== true || state === "active",
        "Activation proof requires an active Production deployment.",
      ),
    app: z.strictObject({
      state: z.enum(["responding", "sign-in-required", "registered", "not-observed", unavailable]),
      url: publicAppUrl.optional(),
    }),
    requestedRevision: z.enum(["unassessed", "awaiting-activation", "live"]),
    schemaSetupSettled: z.literal(true).optional(),
    serviceIssue: z
      .enum(["configuration", "provider-access", "provider-read", "domain-binding", "gateway-read"])
      .optional(),
  })
  .refine(
    ({ requestedRevision, status, deployment, app, serviceIssue }) =>
      requestedRevision !== "live" ||
      [
        status === "available",
        deployment.state === "active",
        app.state === "responding" || app.state === "sign-in-required",
        app.url !== undefined,
        serviceIssue === undefined,
      ].every(Boolean),
    "A live revision requires an active deployment and a verified public app entry",
  );

export type RepositoryProductionNativeStatus = z.infer<
  typeof repositoryProductionNativeStatusSchema
>;
