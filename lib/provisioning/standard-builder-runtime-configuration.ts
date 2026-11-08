import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { AppDescription } from "../repository/app-description";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import {
  hostedOperatorSourceConfigurationSchema,
  validateHostedOperatorSourceConfiguration,
} from "./hosted-operator-source-configuration-schema";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import {
  nativeTargetDatabaseNames,
  selectNativeTargetInstaller,
} from "./native-target-onboarding-deployment";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { readStandardBuilderDestination } from "./hosted-operator-owner";

const id = z.string().min(1);
const fail = () => new HostedOperatorError("builder_destination_configuration_required");
const origin = z.url().refine((text) => {
  const url = new URL(text);
  return (
    url.protocol === "https:" && url.origin === text && url.username === "" && url.password === ""
  );
});
/** Resource custody and intended domain are administrator-owned; project/source come only from Builder receipts. */
export const standardBuilderRuntimeProfileSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  appId: id,
  resourceProfileId: id,
  authOwnership: z.strictObject({
    kind: z.literal("dedicated-app-development"),
    resource: hostedOperatorSourceConfigurationSchema.shape.authDatabase,
  }),
  publicOrigin: origin,
  productionDatabaseIdentity: z.string().regex(/^[a-z0-9.-]+\.neon\.tech\/[a-z][a-z0-9_]*$/u),
  gatewayWorkload: z.strictObject({ audience: z.url(), issuer: z.url(), subject: id }),
  gatewayProductionWorkload: z.strictObject({ audience: z.url(), issuer: z.url(), subject: id }),
});
export const selectStandardBuilderRuntimeProfile = (input: {
  environment: Readonly<Record<string, string | undefined>>;
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
}) => {
  const text = input.environment.PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES;
  const profiles =
    text === undefined || text === ""
      ? []
      : z.array(standardBuilderRuntimeProfileSchema).parse(JSON.parse(text));
  const matches = profiles.filter(
    (profile) =>
      profile.appId === input.appId && isDeepStrictEqual(profile.authority, input.authority),
  );
  if (matches.length > 1) {
    throw new HostedOperatorError("builder_destination_configuration_required");
  }
  return matches[0];
};
export interface StandardBuilderRuntimeCapture {
  selection: CompiledOperatorReleaseSelection;
  description: AppDescription;
}
interface StandardRuntimeInput {
  base: HostedOperatorSourceConfiguration;
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  destination: NonNullable<Awaited<ReturnType<typeof readStandardBuilderDestination>>>;
  captured: StandardBuilderRuntimeCapture;
  environment: Readonly<Record<string, string | undefined>>;
  verifiedPublicOrigin?: string;
}
const deriveDevelopmentRuntime = (input: StandardRuntimeInput) => {
  const policy = input.base.standardDevelopmentRuntime;
  if (policy === undefined) {
    throw fail();
  }
  if (
    input.base.applications[input.appId] !== undefined ||
    !/^[a-zA-Z0-9_-]+$/u.test(input.destination.teamSlug ?? "") ||
    !/^[a-zA-Z0-9_-]+$/u.test(input.destination.name)
  ) {
    throw fail();
  }
  const workloadFor = (environment: "preview" | "production") => ({
    audience: `https://vercel.com/${input.destination.teamSlug}`,
    issuer: `https://oidc.vercel.com/${input.destination.teamSlug}`,
    subject: `owner:${input.destination.teamSlug}:project:${input.destination.name}:environment:${environment}`,
  });
  const ownerDigest = createHash("sha256")
    .update(
      JSON.stringify([
        hostedTenantAuthoritySchema.parse(input.authority),
        input.appId,
        input.destination.projectId,
        input.destination.provisioningRequestId,
        input.destination.provisioningDigest,
      ]),
    )
    .digest("hex");
  const derivedNames = (kind: "app" | "auth") => {
    const stem = `${kind}_${ownerDigest.slice(0, 32)}`;
    return {
      database: stem,
      migratorRole: `${stem}_m`,
      resourceId: policy.nativeNeon.configuration.nativeStore.resourceId,
      runtimeRole: `${stem}_r`,
    };
  };
  if (
    !isDeepStrictEqual(
      policy.nativeNeon.configuration.operator,
      input.base.nativeNeon.configuration.operator,
    )
  ) {
    throw fail();
  }
  const genericResources = validateHostedOperatorSourceConfiguration({
    ...structuredClone(input.base),
    nativeNeon: policy.nativeNeon,
    authDatabase: derivedNames("auth"),
    applications: {},
    standardRuntime: undefined,
  });
  if (input.verifiedPublicOrigin === undefined) {
    throw fail();
  }
  const profile = {
    resourceProfileId: `${policy.policyId}:${ownerDigest}`,
    authOwnership: { kind: "dedicated-app-development" as const, resource: derivedNames("auth") },
    publicOrigin: origin.parse(input.verifiedPublicOrigin),
    productionDatabaseIdentity: policy.productionDatabaseIdentity,
    gatewayWorkload: workloadFor("preview"),
    gatewayProductionWorkload: workloadFor("production"),
  };
  return { appResource: derivedNames("app"), profile, resources: genericResources };
};

export const assembleStandardBuilderRuntimeConfiguration = (
  input: StandardRuntimeInput,
): HostedOperatorSourceConfiguration => {
  const explicit = selectStandardBuilderRuntimeProfile(input);
  const derived = explicit === undefined ? deriveDevelopmentRuntime(input) : undefined;
  const profile = explicit ?? derived?.profile;
  if (profile === undefined) {
    throw fail();
  }
  const { destination, captured } = input;
  const source = captured.selection.publishedSource;
  if (source === undefined || destination.repositoryId === undefined) {
    throw fail();
  }
  const destinationMatches = [
    source.repositoryId === destination.repositoryId,
    destination.teamId === input.base.teamId,
    captured.selection.appId === input.appId,
    captured.description.app.id === input.appId,
    destination.deploymentAccess === "public-app",
  ].every(Boolean);
  if (!destinationMatches || captured.description.backend.kind !== "generated-postgres") {
    throw fail();
  }
  let resources = derived?.resources;
  if (resources === undefined || resources === null) {
    const { base, authority, appId } = input;
    const { resourceProfileId } = profile;
    const { environment } = input;
    resources = resolveNativeTargetResourceProfile({
      appId,
      authority,
      base,
      environment,
      resourceProfileId,
    });
  }
  if (!isDeepStrictEqual(profile.authOwnership.resource, resources.authDatabase)) {
    throw fail();
  }
  const resource = derived?.appResource ??
    resources.applications[input.appId]?.appDatabase ?? {
      ...nativeTargetDatabaseNames(input.appId),
      resourceId: resources.nativeNeon.configuration.nativeStore.resourceId,
    };
  const configuration = validateHostedOperatorSourceConfiguration({
    ...structuredClone(resources),
    composition: "single-project-services",
    standardRuntime: {
      profileId: profile.resourceProfileId,
      authOwnership: profile.authOwnership,
      publicRealmWorkload: {
        ...profile.gatewayProductionWorkload,
        environment: "production",
        projectId: destination.projectId,
        ownerId: destination.teamId,
      },
      productionDatabaseIdentity: profile.productionDatabaseIdentity,
      provisioningRequestId: destination.provisioningRequestId,
      provisioningDigest: destination.provisioningDigest,
      appSpecDigest: captured.selection.appSpecDigest,
      capturedReleaseId: captured.selection.releaseId,
    },
    applications: {
      [input.appId]: {
        accessRoles: [...captured.description.backend.roles],
        appDatabase: resource,
        branch: source.branch,
        projectId: destination.projectId,
        projectSettings: { framework: "services", rootDirectory: "." },
        repoId: source.repositoryId,
      },
    },
    catalogAppIds: [input.appId],
    gateway: {
      authBrowserOrigin: profile.publicOrigin,
      gatewayOrigin: profile.publicOrigin,
      publicOrigin: profile.publicOrigin,
      branch: source.branch,
      environment: "preview",
      gitSha: source.gitSha,
      projectId: destination.projectId,
      repoId: source.repositoryId,
      protectedApplicationIds: [input.appId],
      workload: {
        ...profile.gatewayWorkload,
        environment: "preview",
        projectId: destination.projectId,
        ownerId: destination.teamId,
      },
    },
    sandbox: {
      ...structuredClone(resources.sandbox),
      workers: {
        [input.appId]: selectNativeTargetInstaller(
          resources.sandbox.workers,
          input.appId,
          resources.sandbox.genericInstallerWorker,
        ),
      },
    },
  });
  return configuration;
};
