import type {
  TargetValidationCommandReceipt,
  TargetValidationFailureReceipt,
  TargetValidationReceipt,
} from "../repository/target-validation";
import type { ValidationLogReference } from "../repository/validation-log";

/** Copy the complete immutable log identity; receipt.digest is not an attempt identity. */
export const validationLogReadInput = (
  attemptDigest: string,
  command: TargetValidationCommandReceipt["name"],
  reference: ValidationLogReference,
) => ({
  attemptDigest,
  channel: reference.channel,
  command,
  digest: reference.digest,
  logId: reference.logId,
});

export const validationLogsWithReadInputs = (
  attemptDigest: string,
  command: TargetValidationCommandReceipt,
) => {
  if (command.logs === undefined) {
    return command.logs;
  }
  return {
    stderr: {
      ...command.logs.stderr,
      readInput: validationLogReadInput(attemptDigest, command.name, command.logs.stderr),
    },
    stdout: {
      ...command.logs.stdout,
      readInput: validationLogReadInput(attemptDigest, command.name, command.logs.stdout),
    },
  };
};

export const validationAttemptLogReadInputs = (
  receipt: Pick<
    TargetValidationReceipt | TargetValidationFailureReceipt,
    "attemptDigest" | "commands" | "status"
  >,
) => ({
  attemptDigest: receipt.attemptDigest,
  commands: receipt.commands.map((command) => ({
    logs: validationLogsWithReadInputs(receipt.attemptDigest, command),
    name: command.name,
  })),
  status: receipt.status,
});
