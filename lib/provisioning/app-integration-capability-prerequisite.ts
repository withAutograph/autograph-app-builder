import { z } from "zod";
const actions = {
  app_integration_profile_required:
    "Configure the reviewed isolated central Integrations resource profile through Builder before planning this app capability.",
  app_integration_central_host_required:
    "Complete the separate approved isolated central-host setup and this app's exact Production caller authorization through Builder.",
  app_integration_source_configuration_required:
    "Declare the actual provider read configuration and shared integration routes, then install, validate, capture and review this app through Builder.",
  app_integration_application_runtime_required:
    "Complete this app's own approved resource and schema setup before preparing its optional integration capability.",
  app_integration_worker_required:
    "Configure the pinned shared integration provisioning worker and protected resource credentials before approving optional capability effects.",
};
export const appIntegrationCapabilityPrerequisiteCodeSchema = z.enum([
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
  status: z.literal("blocked"),
  code: appIntegrationCapabilityPrerequisiteCodeSchema,
  nextAction: z.string().min(1),
  providerActivation: z.literal("unassessed"),
  hostedAcceptance: z.literal("unassessed"),
});
export const appIntegrationCapabilityPrerequisiteResponse = (
  error: AppIntegrationCapabilityPrerequisiteError,
) => ({
  status: "blocked" as const,
  code: error.code,
  nextAction: actions[error.code],
  providerActivation: "unassessed" as const,
  hostedAcceptance: "unassessed" as const,
});
