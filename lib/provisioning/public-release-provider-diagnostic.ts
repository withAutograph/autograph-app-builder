import { z } from "zod";
import { vercelProvisionDiagnosticSchema } from "./contracts-schema";

export const githubReleaseHttpCodeSchema = z.enum([
  "bad_credentials",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "rate_limited",
  "provider_unavailable",
]);
export const githubReleaseGraphqlTypeSchema = z.enum([
  "FORBIDDEN",
  "NOT_FOUND",
  "UNPROCESSABLE",
  "RATE_LIMITED",
  "INTERNAL",
  "SERVICE_UNAVAILABLE",
  "GRAPHQL_VALIDATION_FAILED",
]);
export const githubReleaseDiagnosticSchema = z.strictObject({
  code: z.union([githubReleaseHttpCodeSchema, githubReleaseGraphqlTypeSchema]).optional(),
  provider: z.literal("github"),
  requestRef: z
    .string()
    .max(160)
    .regex(/^[A-Fa-f0-9]+(?::[A-Fa-f0-9]+)+$/u)
    .optional(),
  statusCode: z.union([z.literal(200), z.number().int().min(400).max(599)]),
});
/** Keep the original Vercel persisted diagnostic shape byte-for-byte compatible. */
export const publicReleaseProviderDiagnosticSchema = z.union([
  vercelProvisionDiagnosticSchema,
  githubReleaseDiagnosticSchema,
]);
export type PublicReleaseProviderDiagnostic = z.infer<typeof publicReleaseProviderDiagnosticSchema>;
