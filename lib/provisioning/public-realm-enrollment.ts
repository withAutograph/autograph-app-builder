import { z } from "zod";

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const publicRealmResourceSchema = z.strictObject({
  database: sqlName,
  environment: z.enum(["preview", "isolated-development"]),
  hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
  migratorRole: sqlName,
  neon: z.strictObject({ branchId: id, projectId: id }),
  port: z.literal(5432),
  runtimeRole: sqlName,
  schema: z.literal("public"),
  version: z.literal(1),
});
export const publicRealmReleaseBindingSchema = z.strictObject({
  enrollmentRef: z.uuid(),
  operationRef: z.uuid(),
  planDigest: digest,
});
/** New public enrollment; prior installer receipts retain their original classification and approval. */
export const publicRealmEnrollmentSchema = z.strictObject({
  appId: id,
  authority: z.strictObject({
    audience: z.url(),
    issuer: z.url(),
    ownerUserId: id,
    workspaceId: id,
  }),
  enrollmentRef: z.uuid(),
  kind: z.literal("public-isolated-realm-v1"),
  ownerSessionId: id,
  project: z.strictObject({ environment: z.literal("production"), ownerId: id, projectId: id }),
  publicOrigin: origin,
  resource: publicRealmResourceSchema,
  sourceBootstrap: z.strictObject({
    authResourceId: id,
    operationRef: z.uuid(),
    planDigest: digest,
  }),
  version: z.literal(1),
});
export type PublicRealmEnrollment = z.infer<typeof publicRealmEnrollmentSchema>;
export type PublicRealmReleaseBinding = z.infer<typeof publicRealmReleaseBindingSchema>;
