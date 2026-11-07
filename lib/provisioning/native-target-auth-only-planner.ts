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
export const nativeTargetAuthOnlyAuthorityBindingSchema = z
  .object({
    nativeNeon: z.object({
      scope: z.object({ endpointId: z.string().min(1), hostname: z.string().min(1) }).passthrough(),
    }),
  })
  .passthrough();

/** Narrow projection of the full deployment-owned resource profile. */
const authOnlyProfileSchema = z.strictObject({
  id: z.string().min(1),
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  authority: hostedTenantAuthoritySchema,
  configuration: z.strictObject({ authDatabase: resourceSchema }),
});

const proposalSchema = z.strictObject({
  appId: nativeTargetOnboardingPlanSchema.shape.appId,
  authProfileId: z.string().min(1),
  project: z.strictObject({
    name: nativeTargetOnboardingPlanSchema.shape.project.shape.name,
    teamId: z.string().min(1),
    installationId: z.string().min(1),
  }),
  branch: nativeTargetOnboardingPlanSchema.shape.branch,
  appSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  appRole: roleSchema,
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
}) => createHash("sha256").update(JSON.stringify({
  authority: hostedTenantAuthoritySchema.parse(input.authority),
  appId: nativeTargetOnboardingPlanSchema.shape.appId.parse(input.appId),
  profileId: z.string().min(1).parse(input.profileId),
  authDatabase: resourceSchema.parse(input.authDatabase),
  roles: z.array(roleSchema).parse(input.roles),
  authorityBinding: nativeTargetAuthOnlyAuthorityBindingSchema.parse(input.authorityBinding),
  physicalEndpointId: z.string().min(1).parse(input.physicalEndpointId),
})).digest("hex");

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
  const authorityBinding = nativeTargetAuthOnlyAuthorityBindingSchema.parse(input.authAuthorityBinding);
  const publishedSource = publishedAppSourceSchema.parse(input.publishedSource);
  if (
    description.app.id !== proposal.appId ||
    description.backend.kind !== "static" ||
    profile.appId !== proposal.appId ||
    profile.id !== proposal.authProfileId ||
    !isDeepStrictEqual(profile.authority, owner.authority) ||
    proposal.appRole.length === 0 ||
    !roles.includes(proposal.appRole) ||
    roles.length === 0 ||
    profile.configuration.authDatabase.resourceId === input.sharedAuthResourceId ||
    input.selectedPhysicalEndpointId === input.sharedPhysicalEndpointId
  ) {
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
    authority: owner.authority,
    appId: proposal.appId,
    profileId: profile.id,
    authDatabase: profile.configuration.authDatabase,
    roles,
    authorityBinding,
    physicalEndpointId: input.selectedPhysicalEndpointId,
  });
  return nativeTargetAuthOnlyPlanSchema.parse({
    version: 1,
    kind: "native-target-auth-only",
    appId: proposal.appId,
    origin: {
      authority: owner.authority,
      publicSessionId: owner.publicSessionId,
      adapterSessionId: owner.adapterSessionId,
      adapterGeneration: owner.adapterGeneration,
      appSpecDigest: proposal.appSpecDigest,
      capturedDescription: capturedStaticDescriptionProvenance(description),
    },
    project: {
      ...proposal.project,
      projectSettings,
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: proposal.branch,
    publishedSource,
    authResource: {
      profileId: profile.id,
      authorityDigest: authResourceAuthorityDigest,
      resourceId: profile.configuration.authDatabase.resourceId,
      database: profile.configuration.authDatabase.database,
      endpointId: input.selectedPhysicalEndpointId,
      hostname: authorityBinding.nativeNeon.scope.hostname,
    },
    authSchema: input.authSchema,
    appRole: proposal.appRole,
    signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
    cost: { ownership: "current-owner", description: "Isolated Preview Auth only" },
    retention: { policy: "Retain until explicit approved cleanup" },
  });
};

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
  readCapturedDescription: (input: {
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    appSpecDigest: string;
    publicSessionId: string;
  }) => Promise<unknown>;
  readAuthProfile: (input: {
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    profileId: string;
  }) => Promise<unknown>;
  readConfiguredAppRoles: (input: {
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    profileId: string;
  }) => Promise<readonly string[]>;
  readPublishedSource: (input: {
    authority: AuthOnlyPlanOwner["authority"];
    appId: string;
    appSpecDigest: string;
    publicSessionId: string;
  }) => Promise<unknown>;
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
    authority: owner.authority,
    appId: proposal.appId,
    profileId: proposal.authProfileId,
  };
  const [capturedDescription, selectedProfile, configuredAppRoles, publishedSource] = await Promise.all([
    input.readCapturedDescription({
      authority: owner.authority,
      appId: proposal.appId,
      appSpecDigest: proposal.appSpecDigest,
      publicSessionId: owner.publicSessionId,
    }),
    input.readAuthProfile(lookup),
    input.readConfiguredAppRoles(lookup),
    input.readPublishedSource({
      authority: owner.authority,
      appId: proposal.appId,
      appSpecDigest: proposal.appSpecDigest,
      publicSessionId: owner.publicSessionId,
    }),
  ]);
  const authSchema = await input.readAuthSchemaSelection({
    authority: owner.authority,
    appId: proposal.appId,
    appSpecDigest: proposal.appSpecDigest,
    publicSessionId: owner.publicSessionId,
    publishedSource,
  });
  return planNativeTargetAuthOnly({
    owner,
    proposal: {
      appId: proposal.appId,
      authProfileId: proposal.authProfileId,
      project: proposal.project,
      branch: proposal.branch,
      appSpecDigest: proposal.appSpecDigest,
      appRole: proposal.appRole,
    },
    capturedDescription,
    selectedProfile,
    sharedAuthResourceId: input.sharedAuthResourceId,
    sharedPhysicalEndpointId: input.sharedPhysicalEndpointId,
    selectedPhysicalEndpointId: input.selectedPhysicalEndpointId,
    authAuthorityBinding: input.authAuthorityBinding,
    configuredAppRoles,
    publishedSource,
    authSchema,
  });
};
