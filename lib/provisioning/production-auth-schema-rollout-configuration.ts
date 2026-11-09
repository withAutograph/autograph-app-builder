import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { HostedOperatorError } from "./hosted-operator-contract";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import {
  authSchemaRolloutRuntimeSchema,
  authSchemaSqlRoleSchema,
  productionAuthResourceSchema,
} from "./production-auth-schema-rollout-contract";
import type {
  AuthSchemaRolloutRecord,
  AuthSchemaRolloutScope,
} from "./production-auth-schema-rollout-contract";

const id = z.string().min(1);
export const authSchemaRolloutConfigurationSchema = z.strictObject({
  version: z.literal(1),
  builderWorkload: z.strictObject({
    audience: z.url(),
    issuer: z.url(),
    ownerId: id,
    projectId: id,
    subject: id,
    environment: z.literal("production"),
  }),
  profiles: z
    .array(
      z
        .strictObject({
          id,
          label: id,
          administrators: z.array(hostedTenantAuthoritySchema).min(1),
          resource: productionAuthResourceSchema,
          authOperatorRole: authSchemaSqlRoleSchema,
          runtime: authSchemaRolloutRuntimeSchema,
        })
        .refine(
          (value) =>
            ![value.resource.migratorRole, value.resource.runtimeRole].includes(
              value.authOperatorRole,
            ),
        ),
    )
    .min(1),
});
export type AuthSchemaRolloutConfiguration = z.infer<typeof authSchemaRolloutConfigurationSchema>;
export type AuthSchemaRolloutProfile = AuthSchemaRolloutConfiguration["profiles"][number];

/** Service administrator enrollment is deployment-owned, never an app or session input. */
export const readAuthSchemaRolloutConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const raw = environment.PRODUCTION_AUTH_SCHEMA_ROLLOUT_CONFIGURATION;
  if (raw === undefined || raw === "") {
    throw new HostedOperatorError("operator_unavailable");
  }
  const configuration = authSchemaRolloutConfigurationSchema.parse(JSON.parse(raw));
  createOperatorWorkloadVerifier(configuration.builderWorkload);
  return configuration;
};
export const resolveAuthSchemaRolloutProfile = (
  configuration: AuthSchemaRolloutConfiguration,
  scope: AuthSchemaRolloutScope,
): AuthSchemaRolloutProfile => {
  const matches = configuration.profiles.filter(
    (profile) =>
      profile.id === scope.profileId &&
      profile.administrators.some((authority) => isDeepStrictEqual(authority, scope.authority)),
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new HostedOperatorError("authorization_required");
  }
  return matches[0];
};
/** Live authority may retain older pinned workers; it cannot silently retarget an approved operation. */
export const assertAuthSchemaRolloutEnrollment = (
  configuration: AuthSchemaRolloutConfiguration,
  record: AuthSchemaRolloutRecord,
) => {
  const profile = resolveAuthSchemaRolloutProfile(configuration, record.plan.scope);
  if (
    !isDeepStrictEqual(profile.resource, record.plan.resource) ||
    profile.authOperatorRole !== record.plan.authOperatorRole ||
    profile.runtime.migrationConnectionEnvironment !== record.runtime.migrationConnectionEnvironment
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return profile;
};
