import { z } from "zod";

export const publicReleasePrerequisiteCodeSchema = z.enum([
  "public_release_git_revision_required",
  "public_release_integration_capability_required",
  "public_release_integration_removal_required",
  "builder_destination_required",
  "public_release_reconciliation_required",
  "prepared_runtime_required",
  "same_project_auth_required",
  "public_auth_enrollment_required",
  "public_app_contract_required",
  "public_release_source_required",
]);
export type PublicReleasePrerequisiteCode = z.infer<typeof publicReleasePrerequisiteCodeSchema>;
const actions: Record<PublicReleasePrerequisiteCode, string> = {
  public_release_integration_removal_required:
    "Disable this app’s integrations in its existing Integrations page first. Builder must independently verify all bindings are stopped, then offer a fresh release approval naming the reversible app-only authority fence and read-only retention of its two existing settings before publishing the revised app.",
  public_release_integration_capability_required:
    "Complete and select this app’s separately approved integration capability through plan-app-integration-capability and prepare-app-integration-capability, then plan a fresh public application release with that exact operation reference.",
  public_release_git_revision_required:
    "Runtime configuration changed. Validate and review a new source revision through Builder before approving its native Git public release in this same project.",
  public_auth_enrollment_required:
    "Complete the supported public Auth enrollment configuration for this same app before offering its public bootstrap release approval.",
  public_release_reconciliation_required:
    "Resume the retained approved public release and reconcile its uncertain effects before changing the release destination or configuration.",
  builder_destination_required:
    "Resume normal Builder project creation or attachment for this saved app.",
  prepared_runtime_required:
    "Complete the saved app's approved isolated runtime setup in its normal Builder project.",
  same_project_auth_required:
    "Prepare this app's own public BetterAuth configuration in the same Services project through Builder.",
  public_app_contract_required:
    "Update the shared app delivery contract to support public delivery with isolated development authentication, then validate and publish through Builder.",
  public_release_source_required:
    "Validate, independently review, and publish the selected app source through the normal Builder source workflow.",
};
export const recordedBuilderDestinationSchema = z.strictObject({
  appId: z.string().min(1),
  projectId: z.string().min(1),
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
  repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
});
export type RecordedBuilderDestination = z.infer<typeof recordedBuilderDestinationSchema>;
export class PublicReleasePrerequisiteError extends Error {
  readonly code: PublicReleasePrerequisiteCode;
  readonly recordedBuilderDestination?: RecordedBuilderDestination;
  constructor(code: PublicReleasePrerequisiteCode, destination?: RecordedBuilderDestination) {
    super(actions[code]);
    this.name = "PublicReleasePrerequisiteError";
    this.code = code;
    if (destination !== undefined) {
      this.recordedBuilderDestination = recordedBuilderDestinationSchema.parse(destination);
    }
  }
}
export const publicReleasePrerequisiteResponseSchema = z.strictObject({
  status: z.literal("blocked"),
  code: publicReleasePrerequisiteCodeSchema,
  nextAction: z.string().min(1),
  recordedBuilderDestination: recordedBuilderDestinationSchema.optional(),
  authenticatedBehavior: z.literal("unassessed"),
});
export const publicReleasePrerequisiteResponse = (error: PublicReleasePrerequisiteError) => {
  const response: Pick<
    z.infer<typeof publicReleasePrerequisiteResponseSchema>,
    "status" | "code" | "nextAction" | "recordedBuilderDestination"
  > = {
    status: "blocked",
    code: error.code,
    nextAction: actions[error.code],
  };
  if (error.recordedBuilderDestination !== undefined) {
    response.recordedBuilderDestination = error.recordedBuilderDestination;
  }
  return { ...response, authenticatedBehavior: "unassessed" as const };
};
