import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { AppDescription } from "../repository/app-description";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import { validateHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import {
  nativeTargetDatabaseNames,
  selectNativeTargetInstaller,
} from "./native-target-onboarding-deployment";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { readStandardBuilderDestination } from "./hosted-operator-owner";

const id = z.string().min(1);
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
  publicOrigin: origin,
  productionDatabaseIdentity: z.string().regex(/^[a-z0-9.-]+\.neon\.tech\/[a-z][a-z0-9_]*$/u),
  gatewayWorkload: z.strictObject({ audience: z.url(), issuer: z.url(), subject: id }),
});
export interface StandardBuilderRuntimeCapture {
  selection: CompiledOperatorReleaseSelection;
  description: AppDescription;
}
export const assembleStandardBuilderRuntimeConfiguration = (input: {
  base: HostedOperatorSourceConfiguration;
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  destination: NonNullable<Awaited<ReturnType<typeof readStandardBuilderDestination>>>;
  captured: StandardBuilderRuntimeCapture;
  environment: Readonly<Record<string, string | undefined>>;
}): HostedOperatorSourceConfiguration => {
  const fail = () => new HostedOperatorError("builder_destination_configuration_required");
  const text = input.environment.PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES;
  if (text === undefined || text === "") {
    throw fail();
  }
  const profiles = z.array(standardBuilderRuntimeProfileSchema).parse(JSON.parse(text));
  const matches = profiles.filter(
    (profile) =>
      profile.appId === input.appId && isDeepStrictEqual(profile.authority, input.authority),
  );
  const profile = matches.length === 1 ? matches[0] : undefined;
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
  const resources = resolveNativeTargetResourceProfile({
    base: input.base,
    authority: input.authority,
    appId: input.appId,
    resourceProfileId: profile.resourceProfileId,
    environment: input.environment,
  });
  const resource = resources.applications[input.appId]?.appDatabase ?? {
    ...nativeTargetDatabaseNames(input.appId),
    resourceId: resources.nativeNeon.configuration.nativeStore.resourceId,
  };
  const configuration = validateHostedOperatorSourceConfiguration({
    ...structuredClone(resources),
    composition: "single-project-services",
    standardRuntime: {
      profileId: profile.resourceProfileId,
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
        [input.appId]: selectNativeTargetInstaller(resources.sandbox.workers, input.appId),
      },
    },
  });
  return configuration;
};
