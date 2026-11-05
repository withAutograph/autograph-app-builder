import { z } from "zod";

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const publicRealmResourceSchema = z.strictObject({
  version: z.literal(1),
  environment: z.enum(["preview", "isolated-development"]),
  hostname: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
  port: z.literal(5432),
  database: sqlName,
  schema: z.literal("public"),
  runtimeRole: sqlName,
  migratorRole: sqlName,
  neon: z.strictObject({ projectId: id, branchId: id }),
});
export const publicRealmReleaseBindingSchema = z.strictObject({
  enrollmentRef: z.uuid(),
  operationRef: z.uuid(),
  planDigest: digest,
});
/** New public enrollment; prior installer receipts retain their original classification and approval. */
export const publicRealmEnrollmentSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("public-isolated-realm-v1"),
  enrollmentRef: z.uuid(),
  appId: id,
  ownerSessionId: id,
  authority: z.strictObject({
    issuer: z.url(),
    audience: z.url(),
    ownerUserId: id,
    workspaceId: id,
  }),
  publicOrigin: origin,
  project: z.strictObject({ projectId: id, ownerId: id, environment: z.literal("production") }),
  sourceBootstrap: z.strictObject({
    operationRef: z.uuid(),
    planDigest: digest,
    authResourceId: id,
  }),
  resource: publicRealmResourceSchema,
});
export type PublicRealmEnrollment = z.infer<typeof publicRealmEnrollmentSchema>;
export type PublicRealmReleaseBinding = z.infer<typeof publicRealmReleaseBindingSchema>;
