import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { appDescriptionSchema } from "../repository/app-description";
import {
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-plan-schema";
import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import {
  capturedStaticDescriptionProvenance,
  nativeTargetAuthOnlyPlanSchema,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { publishedAppSourceSchema } from "./hosted-operator-artifact-selection";

const roleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/u)
  .refine((role) => !/(?:^|[_-])(?:owner|admin|administrator)(?:[_-]|$)/u.test(role));
const resourceSchema = z.strictObject({
  database: z.string().min(1),
  migratorRole: z.string().min(1),
  resourceId: z.string().min(1),
  runtimeRole: z.string().min(1),
});
export const nativeTargetAuthOnlyAuthorityBindingSchema = z.looseObject({
  nativeNeon: z.object({
    scope: z.looseObject({ endpointId: z.string().min(1), hostname: z.string().min(1) }),
  }),
});

/** Narrow projection of the full deployment-owned resource profile. */
const authOnlyProfileSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  authority: hostedTenantAuthoritySchema,
  configuration: z.strictObject({ authDatabase: resourceSchema }),
  id: z.string().min(1),
});

const proposalSchema = z.strictObject({
  appId: nativeTargetOnboardingPlanSchema.shape.appId,
  appRole: roleSchema,
  appSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  authProfileId: z.string().min(1),
  branch: nativeTargetOnboardingPlanSchema.shape.branch,
  project: z.strictObject({
    name: nativeTargetOnboardingPlanSchema.shape.project.shape.name,
    teamId: z.string().min(1),
    installationId: z.string().min(1),
  }),
});

export interface AuthOnlyPlanOwner {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  publicSessionId: string;
  adapterSessionId: string;
  adapterGeneration: number;
}

export const nativeTargetAuthOnlyAuthorityDigest = (input: {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  profileId: string;
  authDatabase: z.infer<typeof resourceSchema>;
  roles: readonly string[];
  authorityBinding: unknown;
  physicalEndpointId: string;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        appId: nativeTargetOnboardingPlanSchema.shape.appId.parse(input.appId),
        authDatabase: resourceSchema.parse(input.authDatabase),
        authority: hostedTenantAuthoritySchema.parse(input.authority),
        authorityBinding: nativeTargetAuthOnlyAuthorityBindingSchema.parse(input.authorityBinding),
        physicalEndpointId: z.string().min(1).parse(input.physicalEndpointId),
        profileId: z.string().min(1).parse(input.profileId),
        roles: z.array(roleSchema).parse(input.roles),
      }),
    )
    .digest("hex");

/** Resolve only from captured repository output and a deployment-owned isolated Auth profile. */
export const planNativeTargetAuthOnly = (input: {
  owner: AuthOnlyPlanOwner;
  proposal: z.input<typeof proposalSchema>;
  capturedDescription: unknown;
  selectedProfile: unknown;
  sharedAuthResourceId: string;
  sharedPhysicalEndpointId: string;
  selectedPhysicalEndpointId: string;
  authAuthorityBinding: unknown;
  configuredAppRoles: readonly string[];
  publishedSource: unknown;
  authSchema: NativeTargetAuthOnlyPlan["authSchema"];
}): NativeTargetAuthOnlyPlan => {
  const proposal = proposalSchema.parse(input.proposal);
  const owner = {
    ...input.owner,
    authority: hostedTenantAuthoritySchema.parse(input.owner.authority),
  };
  const description = appDescriptionSchema.parse(input.capturedDescription);
  const profile = authOnlyProfileSchema.parse(input.selectedProfile);
  const roles = z.array(roleSchema).parse(input.configuredAppRoles);
  const authorityBinding = nativeTargetAuthOnlyAuthorityBindingSchema.parse(
    input.authAuthorityBinding,
  );
  const publishedSource = publishedAppSourceSchema.parse(input.publishedSource);
  const exactProfile = [
    description.app.id === proposal.appId,
    description.backend.kind === "static",
    profile.appId === proposal.appId,
    profile.id === proposal.authProfileId,
    isDeepStrictEqual(profile.authority, owner.authority),
    proposal.appRole.length !== 0,
    roles.includes(proposal.appRole),
    roles.length !== 0,
    profile.configuration.authDatabase.resourceId !== input.sharedAuthResourceId,
    input.selectedPhysicalEndpointId !== input.sharedPhysicalEndpointId,
  ].every(Boolean);
  if (!exactProfile) {
    throw new Error("native_target_auth_only_resource_mismatch");
  }
  const projectSettings = hostedOperatorAppProjectSettingsSchema.parse({
    ...(description.deployment?.buildCommand === undefined
      ? {}
      : { buildCommand: description.deployment.buildCommand }),
    framework: description.deployment?.framework ?? null,
    rootDirectory: description.app.workspacePath,
    ...(description.deployment?.sourceFilesOutsideRootDirectory === undefined
      ? {}
      : {
          sourceFilesOutsideRootDirectory: description.deployment.sourceFilesOutsideRootDirectory,
        }),
  });
  const authResourceAuthorityDigest = nativeTargetAuthOnlyAuthorityDigest({
    appId: proposal.appId,
    authDatabase: profile.configuration.authDatabase,
    authority: owner.authority,
    authorityBinding,
    physicalEndpointId: input.selectedPhysicalEndpointId,
    profileId: profile.id,
    roles,
  });
  return nativeTargetAuthOnlyPlanSchema.parse({
    appId: proposal.appId,
    appRole: proposal.appRole,
    authResource: {
      authorityDigest: authResourceAuthorityDigest,
      database: profile.configuration.authDatabase.database,
      endpointId: input.selectedPhysicalEndpointId,
      hostname: authorityBinding.nativeNeon.scope.hostname,
      profileId: profile.id,
      resourceId: profile.configuration.authDatabase.resourceId,
    },
    authSchema: input.authSchema,
    branch: proposal.branch,
    cost: { description: "Isolated Preview Auth only", ownership: "current-owner" },
    kind: "native-target-auth-only",
    origin: {
      adapterGeneration: owner.adapterGeneration,
      adapterSessionId: owner.adapterSessionId,
      appSpecDigest: proposal.appSpecDigest,
      authority: owner.authority,
      capturedDescription: capturedStaticDescriptionProvenance(description),
      publicSessionId: owner.publicSessionId,
    },
    project: {
      ...proposal.project,
      projectSettings,
      protection: nativeTargetRequiredProjectProtection,
    },
    publishedSource,
    retention: { policy: "Retain until explicit approved cleanup" },
    signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
    version: 1,
  });
};

// oxlint-disable-next-line anti-slop/no-unknown-returns -- These owner-scoped store reads deliberately return untrusted JSON; the planner validates each value with its existing domain schema.
type ReadOwnedPlanningJson<TLookup> = (input: TLookup) => Promise<unknown>;

/**
 * Read source and custody from private owner-scoped stores immediately before planning.
 * The caller cannot supply a description or Auth resource directly.
 */
export const planNativeTargetAuthOnlyFromOwnedState = async (input: {
  owner: AuthOnlyPlanOwner;
  proposal: z.input<typeof proposalSchema>;
  sharedAuthResourceId: string;
  sharedPhysicalEndpointId: string;
  selectedPhysicalEndpointId: string;
  authAuthorityBinding: unknown;
  readCapturedDescription: ReadOwnedPlanningJson<{
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    appSpecDigest: string;
    publicSessionId: string;
  }>;
  readAuthProfile: ReadOwnedPlanningJson<{
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    profileId: string;
  }>;
  readConfiguredAppRoles: (input: {
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    profileId: string;
  }) => Promise<readonly string[]>;
  readPublishedSource: ReadOwnedPlanningJson<{
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    appSpecDigest: string;
    publicSessionId: string;
  }>;
  readAuthSchemaSelection: (input: {
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    appSpecDigest: string;
    publicSessionId: string;
    publishedSource: unknown;
  }) => Promise<NativeTargetAuthOnlyPlan["authSchema"]>;
}) => {
  const proposal = proposalSchema.parse(input.proposal);
  const owner = {
    ...input.owner,
    authority: hostedTenantAuthoritySchema.parse(input.owner.authority),
  };
  const lookup = {
    appId: proposal.appId,
    authority: owner.authority,
    profileId: proposal.authProfileId,
  };
  const [capturedDescription, selectedProfile, configuredAppRoles, publishedSource] =
    await Promise.all([
      input.readCapturedDescription({
        appId: proposal.appId,
        appSpecDigest: proposal.appSpecDigest,
        authority: owner.authority,
        publicSessionId: owner.publicSessionId,
      }),
      input.readAuthProfile(lookup),
      input.readConfiguredAppRoles(lookup),
      input.readPublishedSource({
        appId: proposal.appId,
        appSpecDigest: proposal.appSpecDigest,
        authority: owner.authority,
        publicSessionId: owner.publicSessionId,
      }),
    ]);
  const authSchema = await input.readAuthSchemaSelection({
    appId: proposal.appId,
    appSpecDigest: proposal.appSpecDigest,
    authority: owner.authority,
    publicSessionId: owner.publicSessionId,
    publishedSource,
  });
  return planNativeTargetAuthOnly({
    authAuthorityBinding: input.authAuthorityBinding,
    authSchema,
    capturedDescription,
    configuredAppRoles,
    owner,
    proposal: {
      appId: proposal.appId,
      appRole: proposal.appRole,
      appSpecDigest: proposal.appSpecDigest,
      authProfileId: proposal.authProfileId,
      branch: proposal.branch,
      project: proposal.project,
    },
    publishedSource,
    selectedPhysicalEndpointId: input.selectedPhysicalEndpointId,
    selectedProfile,
    sharedAuthResourceId: input.sharedAuthResourceId,
    sharedPhysicalEndpointId: input.sharedPhysicalEndpointId,
  });
};
