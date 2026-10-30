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
  id: z.string().min(1),
  authority: hostedTenantAuthoritySchema,
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  configuration: hostedOperatorSourceConfigurationSchema,
});

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
    const text = (input.environment ?? process.env).PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES;
    if (text === undefined || text === "" || input.resourceProfileId === "") {
      throw unavailable();
    }
    const profiles = z.array(profileSchema).parse(JSON.parse(text));
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
    nativeNeon: {
      store: config.nativeNeon.configuration.nativeStore,
      scope: config.nativeNeon.scope,
      connector: config.nativeNeon.configuration.connector,
      operator: config.nativeNeon.configuration.operator,
    },
    gateway: {
      projectId: config.gateway.projectId,
      environment: config.gateway.environment,
      branch: config.gateway.branch,
      authBrowserOrigin: config.gateway.authBrowserOrigin,
      gatewayOrigin: config.gateway.gatewayOrigin,
      publicOrigin: config.gateway.publicOrigin,
      workload: config.gateway.workload,
    },
    operator: {
      projectId: config.operator.projectId,
      environment: config.operator.environment,
      origin: config.operator.origin,
    },
    builderCallbackOrigin: config.builderCallbackOrigin,
    sandbox: {
      projectId: config.sandbox.projectId,
      teamId: config.sandbox.teamId,
      resources: capability(config.sandbox.resourcesWorker),
      auth: capability(config.sandbox.authWorker),
      access: capability(config.sandbox.accessWorker),
      membership: capability(config.sandbox.membershipWorker),
    },
  };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
};
