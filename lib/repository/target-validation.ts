import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { SUPPORTED_VALIDATION_COMMANDS } from "./supported-template";
import {
  applyOverlayRoot,
  inspectApplyOverlay,
  type ApplyCommandResult,
  type TargetApplyReceipt,
} from "./target-apply";

export const TARGET_VALIDATION_TIMEOUT_MS = 300_000;
export const TARGET_VALIDATION_OUTPUT_BYTES = 1_048_576;
export const TARGET_VALIDATION_COMMANDS = SUPPORTED_VALIDATION_COMMANDS;

export type TargetValidationCommand =
  (typeof TARGET_VALIDATION_COMMANDS)[number];
export type TargetValidationCommandName = "check" | "test";

export type ValidationCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  command: TargetValidationCommand;
  validationRoot: string;
}) => Promise<ApplyCommandResult>;

type TargetValidationBinding = {
  sourceSha: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  appSpecDigest: string;
  artifactRevision: string;
  dependencyReceiptDigest: string;
  identityDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
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
  version: 1;
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
  version: 1;
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

function validDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function commandName(
  command: TargetValidationCommand,
): TargetValidationCommandName {
  return command === "mise run check" ? "check" : "test";
}

export function validationOverlayRoot(
  applyDigest: string,
  name: TargetValidationCommandName,
): string {
  if (!validDigest(applyDigest))
    throw new Error("The target apply digest is invalid.");
  return `/workspace/.app-builder/validation/${applyDigest}/${name}/repository`;
}

export function validationBinding(
  apply: TargetApplyReceipt,
): TargetValidationBinding {
  return {
    sourceSha: apply.sourceSha,
    eligibilityDigest: apply.eligibilityDigest,
    workspaceDigest: apply.workspaceDigest,
    appSpecDigest: apply.appSpecDigest,
    artifactRevision: apply.artifactRevision,
    dependencyReceiptDigest: apply.dependencyReceiptDigest,
    identityDigest: apply.identityDigest,
    imageDigest: apply.imageDigest,
    dependencyCacheDigest: apply.dependencyCacheDigest,
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
  if (
    apply.applyRoot !== `/workspace/${applyOverlayRoot(apply.proposalDigest)}`
  )
    throw new Error("The target apply overlay root is not proposal-bound.");
  const unsigned = {
    version: 1 as const,
    status: "pending" as const,
    ...validationBinding(apply),
    commands: TARGET_VALIDATION_COMMANDS.map((command) => {
      const name = commandName(command);
      return {
        name,
        command,
        validationRoot: validationOverlayRoot(apply.digest, name),
      };
    }),
    startedByCallId,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}

function assertAttemptMatchesApply(
  attempt: TargetValidationAttemptReceipt,
  apply: TargetApplyReceipt,
): void {
  const expected = createTargetValidationAttempt(
    apply,
    attempt.startedByCallId,
  );
  if (JSON.stringify(attempt) !== JSON.stringify(expected))
    throw new Error(
      "The pending validation attempt no longer matches the exact apply receipt.",
    );
}

function attemptBinding(
  attempt: TargetValidationAttemptReceipt,
): TargetValidationBinding {
  return {
    sourceSha: attempt.sourceSha,
    eligibilityDigest: attempt.eligibilityDigest,
    workspaceDigest: attempt.workspaceDigest,
    appSpecDigest: attempt.appSpecDigest,
    artifactRevision: attempt.artifactRevision,
    dependencyReceiptDigest: attempt.dependencyReceiptDigest,
    identityDigest: attempt.identityDigest,
    imageDigest: attempt.imageDigest,
    dependencyCacheDigest: attempt.dependencyCacheDigest,
    proposalDigest: attempt.proposalDigest,
    applyDigest: attempt.applyDigest,
    appliedTreeDigest: attempt.appliedTreeDigest,
    changedContentDigest: attempt.changedContentDigest,
  };
}

async function materializeValidationOverlay(input: {
  sandbox: SandboxSession;
  applyRoot: string;
  command: PlannedValidationCommand;
}): Promise<void> {
  const relativeRoot = input.command.validationRoot.replace(
    /^\/workspace\//u,
    "",
  );
  const parent = relativeRoot.slice(0, relativeRoot.lastIndexOf("/"));
  const absent = await input.sandbox.run({
    command: `test ! -e ${input.command.validationRoot}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(TARGET_VALIDATION_TIMEOUT_MS),
  });
  if (absent.exitCode !== 0) throw new Error("ValidationOverlayExists");
  await ensureSandboxDirectories(input.sandbox, [parent]);
  const copy = await input.sandbox.run({
    command: `cp -R ${input.applyRoot} ${input.command.validationRoot}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(TARGET_VALIDATION_TIMEOUT_MS),
  });
  if (
    copy.exitCode !== 0 ||
    Buffer.byteLength(copy.stdout) > TARGET_VALIDATION_OUTPUT_BYTES ||
    Buffer.byteLength(copy.stderr) > TARGET_VALIDATION_OUTPUT_BYTES
  )
    throw new Error("ValidationOverlayCopyFailed");
}

export function sandboxValidationCommandExecutor(): ValidationCommandExecutor {
  return async ({ sandbox, command, validationRoot }) =>
    await sandbox.run({
      command,
      workingDirectory: validationRoot,
      abortSignal: AbortSignal.timeout(TARGET_VALIDATION_TIMEOUT_MS),
    });
}

export function fixtureValidationCommandExecutor(): ValidationCommandExecutor {
  return async ({ appId, command }) =>
    appId === "validation-failure" && command === "mise run check"
      ? { exitCode: 1, stdout: "", stderr: "fixture validation failure" }
      : { exitCode: 0, stdout: `${command} passed`, stderr: "" };
}

function failureReceipt(
  attempt: TargetValidationAttemptReceipt,
  commands: readonly TargetValidationCommandReceipt[],
  reason: TargetValidationFailureReason,
): TargetValidationFailureReceipt {
  const unsigned = {
    version: 1 as const,
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

export function appliedOverlayDriftFailure(input: {
  attempt: TargetValidationAttemptReceipt;
  receipt: TargetValidationReceipt | TargetValidationFailureReceipt;
}): TargetValidationFailureReceipt {
  return failureReceipt(
    input.attempt,
    input.receipt.commands,
    "applied-overlay-drift",
  );
}

export async function executeProposalBoundValidation(input: {
  sandbox: SandboxSession;
  executor: ValidationCommandExecutor;
  snapshotter?: typeof inspectApplyOverlay;
  verifyProtectedState?: () => Promise<void>;
  apply: TargetApplyReceipt;
  attempt: TargetValidationAttemptReceipt;
  appId: string;
}): Promise<TargetValidationResult> {
  assertAttemptMatchesApply(input.attempt, input.apply);
  const snapshotter = input.snapshotter ?? inspectApplyOverlay;
  const commands: TargetValidationCommandReceipt[] = [];
  for (const planned of input.attempt.commands) {
    try {
      await input.verifyProtectedState?.();
    } catch {
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          "protected-workspace-drift",
        ),
      };
    }
    try {
      await materializeValidationOverlay({
        sandbox: input.sandbox,
        applyRoot: input.apply.applyRoot,
        command: planned,
      });
    } catch {
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          "materialization-failed",
        ),
      };
    }
    const before = await snapshotter(input.sandbox, planned.validationRoot);
    if (before.treeDigest !== input.apply.postTreeDigest)
      return {
        ok: false,
        receipt: failureReceipt(input.attempt, commands, "input-tree-mismatch"),
      };
    try {
      await input.verifyProtectedState?.();
    } catch {
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          "protected-workspace-drift",
        ),
      };
    }
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
      inputTreeDigest: before.treeDigest,
      exitCode: result.exitCode,
      stdoutDigest: sha256(result.stdout),
      stderrDigest: sha256(result.stderr),
    };
    commands.push(commandReceipt);
    try {
      await input.verifyProtectedState?.();
    } catch {
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          "protected-workspace-drift",
        ),
      };
    }
    if (
      Buffer.byteLength(result.stdout) > TARGET_VALIDATION_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr) > TARGET_VALIDATION_OUTPUT_BYTES
    )
      return {
        ok: false,
        receipt: failureReceipt(input.attempt, commands, "output-limit"),
      };
    if (result.exitCode !== 0)
      return {
        ok: false,
        receipt: failureReceipt(input.attempt, commands, "command-failed"),
      };
  }
  const unsigned = {
    version: 1 as const,
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
