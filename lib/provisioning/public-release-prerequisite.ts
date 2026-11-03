import { z } from "zod";

export const publicReleasePrerequisiteCodeSchema = z.enum([
  "builder_destination_required",
  "prepared_runtime_required",
  "same_project_auth_required",
  "public_app_contract_required",
  "public_release_source_required",
]);
export type PublicReleasePrerequisiteCode = z.infer<typeof publicReleasePrerequisiteCodeSchema>;
const actions: Record<PublicReleasePrerequisiteCode, string> = {
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
export class PublicReleasePrerequisiteError extends Error {
  readonly code: PublicReleasePrerequisiteCode;
  constructor(code: PublicReleasePrerequisiteCode) {
    super(actions[code]);
    this.name = "PublicReleasePrerequisiteError";
    this.code = code;
  }
}
export const publicReleasePrerequisiteResponseSchema = z.strictObject({
  status: z.literal("blocked"),
  code: publicReleasePrerequisiteCodeSchema,
  nextAction: z.string().min(1),
  authenticatedBehavior: z.literal("unassessed"),
});
export const publicReleasePrerequisiteResponse = (error: PublicReleasePrerequisiteError) => ({
  status: "blocked" as const,
  code: error.code,
  nextAction: actions[error.code],
  authenticatedBehavior: "unassessed" as const,
});
