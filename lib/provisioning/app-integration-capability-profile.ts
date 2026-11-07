import { z } from "zod";
import { integrationCapabilityMembershipSchema } from "./app-integration-capability-contract";
import { AppIntegrationCapabilityPrerequisiteError } from "./app-integration-capability-prerequisite";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const appIntegrationCapabilityProfileSchema = z
  .strictObject({
    applications: z.record(
      id,
      z.strictObject({
        controlRuntimeRole: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
        serviceMemberships: z.array(integrationCapabilityMembershipSchema).min(1),
      }),
    ),
    controlSchema: z.strictObject({ artifactRef: id, sha256: digest }),
    id,
    version: z.literal(1),
    worker: z.strictObject({ reference: id, sha256: digest }),
  })
  .superRefine((profile, context) => {
    const roles = Object.values(profile.applications).map((app) => app.controlRuntimeRole);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: "custom",
        message: "Each app requires its own isolated control SQL principal",
      });
    }
  });
export const readAppIntegrationCapabilityProfile = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  try {
    return appIntegrationCapabilityProfileSchema.parse(
      JSON.parse(environment.PROTECTED_APP_INTEGRATION_CAPABILITY_PROFILE ?? "null"),
    );
  } catch {
    throw new AppIntegrationCapabilityPrerequisiteError("app_integration_profile_required");
  }
};
export const selectedAppIntegrationCapabilityProfile = (
  profile: z.infer<typeof appIntegrationCapabilityProfileSchema>,
  appId: string,
) => ({
  application: profile.applications[appId],
  controlSchema: profile.controlSchema,
  id: profile.id,
  version: profile.version,
  worker: profile.worker,
});
