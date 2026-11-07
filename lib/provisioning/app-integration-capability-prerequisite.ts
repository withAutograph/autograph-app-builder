import { z } from "zod";

const actions = {
  app_integration_application_runtime_required:
    "Complete this app's own approved resource and schema setup before preparing its optional integration capability.",
  app_integration_caller_registration_required:
    "Prepare a fresh ordinary normal caller-registration approval for this recorded app project and the verified existing platform reference. No isolated Preview setup, old caller approval or operator identity can substitute.",
  app_integration_central_host_required:
    "Complete the separate approved isolated central-host setup and this app's exact Production caller authorization through Builder.",
  app_integration_existing_platform_required:
    "Select and independently verify this app’s already-owned normal Services Integrations reference with dedicated development resources and QuickBooks Sandbox access. No isolated Preview setup or alternate project is selected.",
  app_integration_profile_required:
    "Configure this app’s reviewed integration schema, worker and restricted role profile, and select its verified existing normal platform Integrations reference through Builder.",
  app_integration_resource_provenance_required:
    "Select the shared platform control resource’s actual approved owner-scoped custody receipt and independently verify its dedicated development Neon identity. Reflected runtime IDs, app/Auth policy selections and old onboarding approvals cannot substitute.",
  app_integration_source_configuration_required:
    "Declare the actual provider read configuration and shared integration routes, then install, validate, capture and review this app through Builder.",
  app_integration_worker_required:
    "Configure the pinned shared integration provisioning worker and protected resource credentials before approving optional capability effects.",
};
export const appIntegrationCapabilityPrerequisiteCodeSchema = z.enum([
  "app_integration_resource_provenance_required",
  "app_integration_caller_registration_required",
  "app_integration_existing_platform_required",
  "app_integration_profile_required",
  "app_integration_central_host_required",
  "app_integration_source_configuration_required",
  "app_integration_application_runtime_required",
  "app_integration_worker_required",
]);
export class AppIntegrationCapabilityPrerequisiteError extends Error {
  readonly code: keyof typeof actions;
  constructor(code: keyof typeof actions) {
    super(actions[code]);
    this.code = code;
    this.name = "AppIntegrationCapabilityPrerequisiteError";
  }
}
export const appIntegrationCapabilityPrerequisiteResponseSchema = z.strictObject({
  code: appIntegrationCapabilityPrerequisiteCodeSchema,
  hostedAcceptance: z.literal("unassessed"),
  nextAction: z.string().min(1),
  providerActivation: z.literal("unassessed"),
  status: z.literal("blocked"),
});
export const appIntegrationCapabilityPrerequisiteResponse = (
  error: AppIntegrationCapabilityPrerequisiteError,
) => ({
  code: error.code,
  hostedAcceptance: "unassessed" as const,
  nextAction: actions[error.code],
  providerActivation: "unassessed" as const,
  status: "blocked" as const,
});
