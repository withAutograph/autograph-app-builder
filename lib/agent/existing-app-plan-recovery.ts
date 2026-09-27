import { ExistingApplicationChangesRequiredError } from "@/lib/repository/existing-application-changes-required-error";

/** Recording a design can accept its AppSpec before an existing app's edits are known. */
export const continuePrototypePlanning = async (plan: () => Promise<void>) => {
  try {
    await plan();
    return { implementationPlanReady: true as const };
  } catch (error) {
    if (!(error instanceof ExistingApplicationChangesRequiredError)) {
      throw error;
    }
    return {
      implementationPlanReady: false as const,
      nextAction:
        "Inspect the existing app and call accept_app_spec with existingAppChanges containing the complete replacement content for each app-owned file to change. The accepted AppSpec is saved; do not request build approval until accept_app_spec returns a canonical proposal.",
    };
  }
};
