import { z } from "zod";
const actions = {
  central_host_setup_recovery_required:
    "Resume the original retained central setup through its saved Builder owner session. A new setup intent cannot replace an unresolved or completed setup for this same profile and project.",
  central_host_environment_isolation_required:
    "Review the existing central project’s inherited Preview settings and configure an explicitly approved isolated branch environment before central setup. Existing global settings remain untouched.",
  central_host_profile_required:
    "Configure the reviewed isolated central resource and provider profile through Builder before planning setup.",
  central_host_source_required:
    "Capture and review the exact central Services source and fixed workers through Builder before planning publication.",
  central_host_setup_required:
    "Complete the separately approved central host setup and independently verify its signed native deployment receipt before adding this app caller.",
  central_host_destination_required:
    "Reconcile this saved app's normal Builder project and ownership before planning its caller grant.",
};
export const centralHostPrerequisiteCodeSchema = z.enum([
  "central_host_setup_recovery_required",
  "central_host_environment_isolation_required",
  "central_host_profile_required",
  "central_host_source_required",
  "central_host_setup_required",
  "central_host_destination_required",
]);
export class CentralHostPrerequisiteError extends Error {
  readonly code: keyof typeof actions;
  constructor(code: keyof typeof actions) {
    super(actions[code]);
    this.code = code;
    this.name = "CentralHostPrerequisiteError";
  }
}
export const centralHostPrerequisiteResponseSchema = z.strictObject({
  status: z.literal("blocked"),
  code: centralHostPrerequisiteCodeSchema,
  nextAction: z.string().min(1),
});
export const centralHostPrerequisiteResponse = (error: CentralHostPrerequisiteError) => ({
  status: "blocked" as const,
  code: error.code,
  nextAction: actions[error.code],
});
