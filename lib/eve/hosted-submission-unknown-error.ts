export const hostedSubmissionVerificationSteps = [
  "start_operation_kind",
  "start_operation_state",
  "start_creation_digest_missing",
  "child_lookup",
  "child_missing",
  "child_shape",
  "child_identity",
  "child_tenant",
  "child_creation_digest",
  "child_operation_lookup",
  "child_operation_binding",
  "activation_prerequisites",
  "activation_transport",
  "activation_receipt",
] as const;
export type HostedSubmissionVerificationStep = (typeof hostedSubmissionVerificationSteps)[number];

export class HostedSubmissionUnknownError extends Error {
  readonly verificationStep?: HostedSubmissionVerificationStep;

  constructor(verificationStep?: HostedSubmissionVerificationStep) {
    super(
      "The hosted Eve submission outcome is unknown. Retry the exact request to check its durable result.",
    );
    this.name = "HostedSubmissionUnknownError";
    this.verificationStep = verificationStep;
  }
}
