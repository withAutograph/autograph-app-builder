import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import {
  supportedValidationCommands,
  SUPPORTED_VALIDATION_TEST_SHARDS,
} from "./supported-template";
import {
  ARRUSTED_APP_VALIDATION_SHA256,
  type ExecutionDependencyLayout,
} from "./dependency-cache";
import {
  type ApplyCommandResult,
  type TargetApplyReceipt,
} from "./target-apply";

export const TARGET_VALIDATION_TIMEOUT_MS = 300_000;
export type TargetValidationCommand =
  | `mise run app:check-build ${string}`
  | `mise run app:test ${string} ${string}`;
export type TargetValidationCommandName = "check-build" | "test";

export type ValidationCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  command: TargetValidationCommand;
  validationRoot: string;
}) => Promise<ApplyCommandResult>;

type TargetValidationBinding = {
  appId: string;
  testShards: readonly string[];
  appValidationSha256: string;
  sourceSha: string;
  sourceTree: string;
  sourceReceiptDigest: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  appSpecDigest: string;
  appSpecPath: string;
  artifactRevision: string;
  dependencyReceiptDigest: string;
  identityDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
  dependencyCacheContentDigest: string;
  proposalDigest: string;
  applyDigest: string;
  appliedTreeDigest: string;
  changedContentDigest: string;
};

export type PlannedValidationCommand = {
  name: TargetValidationCommandName;
  command: TargetValidationCommand;
  validationRoot: string;
};

export type TargetValidationAttemptReceipt = TargetValidationBinding & {
  version: 3;
  status: "pending";
  commands: readonly PlannedValidationCommand[];
  startedByCallId: string;
  digest: string;
};

export type TargetValidationCommandReceipt = PlannedValidationCommand & {
  inputTreeDigest: string;
  exitCode: number;
  stdoutDigest: string;
  stderrDigest: string;
};

type ValidationReceiptBase = TargetValidationBinding & {
  version: 3;
  attemptDigest: string;
  commands: readonly TargetValidationCommandReceipt[];
  validatedByCallId: string;
};

export type TargetValidationReceipt = ValidationReceiptBase & {
  status: "passed";
  digest: string;
};

export type TargetValidationFailureReason =
  | "materialization-failed"
  | "input-tree-mismatch"
  | "command-failed"
  | "command-timeout"
  | "output-limit"
  | "execution-error"
  | "protected-workspace-drift"
  | "applied-overlay-drift";

export type TargetValidationFailureReceipt = ValidationReceiptBase & {
  status: "failed";
  reason: TargetValidationFailureReason;
  recoveryRequired: true;
  digest: string;
};

export type TargetValidationResult =
  | { ok: true; receipt: TargetValidationReceipt }
  | { ok: false; receipt: TargetValidationFailureReceipt };

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function validationOverlayRoot(
  applyDigest: string,
  name: TargetValidationCommandName,
): string {
  void applyDigest;
  return `/workspace/.app-builder/validation/${name}/repository`;
}

export function validationBinding(
  apply: TargetApplyReceipt,
): TargetValidationBinding {
  return {
    appId: apply.targetReceipt.appId,
    testShards: SUPPORTED_VALIDATION_TEST_SHARDS,
    appValidationSha256: ARRUSTED_APP_VALIDATION_SHA256,
    sourceSha: apply.sourceSha,
    sourceTree: apply.sourceTree,
    sourceReceiptDigest: apply.sourceReceiptDigest,
    eligibilityDigest: apply.eligibilityDigest,
    workspaceDigest: apply.workspaceDigest,
    appSpecDigest: apply.appSpecDigest,
    appSpecPath: apply.appSpecPath,
    artifactRevision: apply.artifactRevision,
    dependencyReceiptDigest: apply.dependencyReceiptDigest,
    identityDigest: apply.identityDigest,
    imageDigest: apply.imageDigest,
    dependencyCacheDigest: apply.dependencyCacheDigest,
    dependencyCacheContentDigest: apply.dependencyCacheContentDigest,
    proposalDigest: apply.proposalDigest,
    applyDigest: apply.digest,
    appliedTreeDigest: apply.postTreeDigest,
    changedContentDigest: apply.changedContentDigest,
  };
}

export function createTargetValidationAttempt(
  apply: TargetApplyReceipt,
  startedByCallId: string,
): TargetValidationAttemptReceipt {
  const unsigned = {
    version: 3 as const,
    status: "pending" as const,
    ...validationBinding(apply),
    commands: supportedValidationCommands(
      apply.targetReceipt.appId,
      SUPPORTED_VALIDATION_TEST_SHARDS,
    ).map(({ command, name }) => ({
      name,
      command,
      validationRoot: apply.applyRoot,
    })),
    startedByCallId,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}

function attemptBinding(
  attempt: TargetValidationAttemptReceipt,
): TargetValidationBinding {
  return {
    appId: attempt.appId,
    testShards: attempt.testShards,
    appValidationSha256: attempt.appValidationSha256,
    sourceSha: attempt.sourceSha,
    sourceTree: attempt.sourceTree,
    sourceReceiptDigest: attempt.sourceReceiptDigest,
    eligibilityDigest: attempt.eligibilityDigest,
    workspaceDigest: attempt.workspaceDigest,
    appSpecDigest: attempt.appSpecDigest,
    appSpecPath: attempt.appSpecPath,
    artifactRevision: attempt.artifactRevision,
    dependencyReceiptDigest: attempt.dependencyReceiptDigest,
    identityDigest: attempt.identityDigest,
    imageDigest: attempt.imageDigest,
    dependencyCacheDigest: attempt.dependencyCacheDigest,
    dependencyCacheContentDigest: attempt.dependencyCacheContentDigest,
    proposalDigest: attempt.proposalDigest,
    applyDigest: attempt.applyDigest,
    appliedTreeDigest: attempt.appliedTreeDigest,
    changedContentDigest: attempt.changedContentDigest,
  };
}

export function sandboxValidationCommandExecutor(): ValidationCommandExecutor {
  return async ({ sandbox, appId, command, validationRoot }) => {
    const run = (script: "check" | "build" | "test") =>
      sandbox.run({
        command:
          script === "test"
            ? `bun run --cwd apps/${appId} test -- --shard=1/1`
            : `bun run --cwd apps/${appId} ${script}`,
        workingDirectory: validationRoot,
        abortSignal: AbortSignal.timeout(TARGET_VALIDATION_TIMEOUT_MS),
      });
    if (command.startsWith("mise run app:check-build ")) {
      const checked = await run("check");
      if (checked.exitCode !== 0) return checked;
      const built = await run("build");
      return {
        exitCode: built.exitCode,
        stdout: `${checked.stdout}\n${built.stdout}`,
        stderr: `${checked.stderr}\n${built.stderr}`,
      };
    }
    return await run("test");
  };
}

export function fixtureValidationCommandExecutor(): ValidationCommandExecutor {
  return async ({ appId, command }) =>
    appId === "validation-failure" &&
    command.startsWith("mise run app:check-build ")
      ? { exitCode: 1, stdout: "", stderr: "fixture validation failure" }
      : { exitCode: 0, stdout: `${command} passed`, stderr: "" };
}

function failureReceipt(
  attempt: TargetValidationAttemptReceipt,
  commands: readonly TargetValidationCommandReceipt[],
  reason: TargetValidationFailureReason,
): TargetValidationFailureReceipt {
  const unsigned = {
    version: 3 as const,
    ...attemptBinding(attempt),
    status: "failed" as const,
    attemptDigest: attempt.digest,
    commands,
    validatedByCallId: attempt.startedByCallId,
    reason,
    recoveryRequired: true as const,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}

export async function executeProposalBoundValidation(input: {
  sandbox: SandboxSession;
  executor: ValidationCommandExecutor;
  apply: TargetApplyReceipt;
  attempt: TargetValidationAttemptReceipt;
  dependencyLayout?: ExecutionDependencyLayout;
  appId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<TargetValidationResult> {
  const commands: TargetValidationCommandReceipt[] = [];
  for (const planned of input.attempt.commands) {
    let result: ApplyCommandResult;
    try {
      result = await input.executor({
        sandbox: input.sandbox,
        appId: input.appId,
        command: planned.command,
        validationRoot: planned.validationRoot,
      });
    } catch (error) {
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          error instanceof Error && error.name === "TimeoutError"
            ? "command-timeout"
            : "execution-error",
        ),
      };
    }
    const commandReceipt = {
      ...planned,
      inputTreeDigest: input.apply.postTreeDigest,
      exitCode: result.exitCode,
      stdoutDigest: sha256(result.stdout),
      stderrDigest: sha256(result.stderr),
    };
    commands.push(commandReceipt);
    if (result.exitCode !== 0)
      return {
        ok: false,
        receipt: failureReceipt(input.attempt, commands, "command-failed"),
      };
  }
  const unsigned = {
    version: 3 as const,
    ...attemptBinding(input.attempt),
    status: "passed" as const,
    attemptDigest: input.attempt.digest,
    commands,
    validatedByCallId: input.attempt.startedByCallId,
  };
  return {
    ok: true,
    receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
  };
}
