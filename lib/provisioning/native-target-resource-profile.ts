import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  hostedOperatorSourceConfigurationSchema,
  validateHostedOperatorSourceConfiguration,
} from "./hosted-operator-source-configuration-schema";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";

const profileSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  authority: hostedTenantAuthoritySchema,
  configuration: hostedOperatorSourceConfigurationSchema,
  id: z.string().min(1),
});

const authOnlyProfileSchema = profileSchema.refine(
  (profile) =>
    profile.configuration.authOnlyApplications?.[profile.appId] !== undefined &&
    profile.configuration.applications[profile.appId] === undefined,
  "Additive resource profiles must declare an Auth-only app without an application database.",
);

/** Select only a deployment-owned profile bound to the authenticated canonical app owner. */
export const resolveNativeTargetResourceProfile = (input: {
  base: HostedOperatorSourceConfiguration;
  resourceProfileId?: string;
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): HostedOperatorSourceConfiguration => {
  if (input.resourceProfileId === undefined) {
    return input.base;
  }
  const unavailable = () => new Error("Protected operator resource profile is unavailable.");
  try {
    const authority = hostedTenantAuthoritySchema.parse(input.authority);
    const environment = input.environment ?? process.env;
    const sharedText = environment.PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES;
    const authOnlyText = environment.PROTECTED_HOSTED_OPERATOR_AUTH_ONLY_RESOURCE_PROFILES;
    if (input.resourceProfileId === "") {
      throw unavailable();
    }
    // A separate private setting adds Auth-only custody without rewriting the shared inventory.
    // Parse both inventories before selection: malformed input and duplicate IDs never grant fallback authority.
    const profiles = [
      ...(sharedText === undefined || sharedText === ""
        ? []
        : z.array(profileSchema).parse(JSON.parse(sharedText))),
      ...(authOnlyText === undefined || authOnlyText === ""
        ? []
        : z.array(authOnlyProfileSchema).parse(JSON.parse(authOnlyText))),
    ];
    const selected = profiles.filter((profile) => profile.id === input.resourceProfileId);
    if (selected.length !== 1) {
      throw unavailable();
    }
    const profile = selected[0];
    if (
      profile === undefined ||
      profile.appId !== input.appId ||
      !isDeepStrictEqual(profile.authority, authority)
    ) {
      throw unavailable();
    }
    const base = validateHostedOperatorSourceConfiguration(input.base);
    const configuration = validateHostedOperatorSourceConfiguration(profile.configuration);
    const boundariesMatch = [
      isDeepStrictEqual(configuration.workloadPolicy, base.workloadPolicy),
      configuration.teamId === base.teamId,
      configuration.operator.projectId === base.operator.projectId,
      configuration.operator.environment === base.operator.environment,
      configuration.operator.origin === base.operator.origin,
      isDeepStrictEqual(
        configuration.nativeNeon.configuration.operator,
        base.nativeNeon.configuration.operator,
      ),
      configuration.builderCallbackOrigin === base.builderCallbackOrigin,
      configuration.sandbox.projectId === base.sandbox.projectId,
      configuration.sandbox.teamId === base.sandbox.teamId,
    ].every(Boolean);
    if (!boundariesMatch) {
      throw unavailable();
    }
    return configuration;
  } catch {
    throw unavailable();
  }
};

/** Pin resource/realm/capability authority, not ordinary source or deployment versions. */
export const nativeTargetResourceProfileAuthorityDigest = (
  input: HostedOperatorSourceConfiguration,
): string => {
  const config = validateHostedOperatorSourceConfiguration(input);
  const capability = (worker: { operationScope: string; subcommand: string } | undefined) =>
    worker === undefined
      ? undefined
      : { operationScope: worker.operationScope, subcommand: worker.subcommand };
  const authority = {
    authDatabase: config.authDatabase,
    builderCallbackOrigin: config.builderCallbackOrigin,
    gateway: {
      authBrowserOrigin: config.gateway.authBrowserOrigin,
      branch: config.gateway.branch,
      environment: config.gateway.environment,
      gatewayOrigin: config.gateway.gatewayOrigin,
      projectId: config.gateway.projectId,
      publicOrigin: config.gateway.publicOrigin,
      workload: config.gateway.workload,
    },
    nativeNeon: {
      connector: config.nativeNeon.configuration.connector,
      operator: config.nativeNeon.configuration.operator,
      scope: config.nativeNeon.scope,
      store: config.nativeNeon.configuration.nativeStore,
    },
    operator: {
      environment: config.operator.environment,
      origin: config.operator.origin,
      projectId: config.operator.projectId,
    },
    sandbox: {
      access: capability(config.sandbox.accessWorker),
      auth: capability(config.sandbox.authWorker),
      membership: capability(config.sandbox.membershipWorker),
      projectId: config.sandbox.projectId,
      resources: capability(config.sandbox.resourcesWorker),
      teamId: config.sandbox.teamId,
    },
  };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
};
