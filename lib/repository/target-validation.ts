import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import {
  supportedValidationCommands,
  SUPPORTED_VALIDATION_TEST_SHARDS,
} from "./supported-template";
import { ARRUSTED_APP_VALIDATION_SHA256 } from "./dependency-cache";
import {
  applyOverlayRoot,
  assertCurrentTargetApplyReceipt,
  inspectApplyOverlay,
  type ApplyCommandResult,
  type TargetApplyReceipt,
} from "./target-apply";

export const TARGET_VALIDATION_TIMEOUT_MS = 300_000;
export const TARGET_VALIDATION_OUTPUT_BYTES = 1_048_576;
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
  eligibilityDigest: string;
  workspaceDigest: string;
  appSpecDigest: string;
  appSpecPath: string;
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

function validDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

export function assertTargetValidationSourceBindings(input: {
  apply: TargetApplyReceipt;
  planningTreeDigest: string;
  preparedTreeDigest: string;
}): void {
  if (input.planningTreeDigest !== input.apply.planningTreeDigest)
    throw new Error("The planning overlay changed before target validation.");
  if (input.preparedTreeDigest !== input.apply.preTreeDigest)
    throw new Error("The prepared source changed before target validation.");
}

export function assertReusableTargetApplyReceipt(input: {
  apply: TargetApplyReceipt;
  expectedAppSpecPath: string;
  appliedTreeDigest: string;
  planningTreeDigest: string;
  preparedTreeDigest: string;
}): void {
  assertCurrentTargetApplyReceipt(input.apply);
  if (input.apply.appSpecPath !== input.expectedAppSpecPath)
    throw new Error("The accepted AppSpec path changed after target apply.");
  assertTargetValidationSourceBindings(input);
  if (input.appliedTreeDigest !== input.apply.postTreeDigest)
    throw new Error("The applied overlay changed after its durable receipt.");
}

export function assertReusableTargetValidationReceipt(input: {
  apply: TargetApplyReceipt;
  validation: TargetValidationReceipt;
  expectedAppSpecPath: string;
  appliedTreeDigest: string;
  planningTreeDigest: string;
  preparedTreeDigest: string;
}): void {
  assertCurrentTargetApplyReceipt(input.apply);
  if (input.apply.appSpecPath !== input.expectedAppSpecPath)
    throw new Error(
      "The accepted AppSpec path changed after target validation.",
    );
  assertTargetValidationSourceBindings(input);
  if (input.appliedTreeDigest !== input.apply.postTreeDigest)
    throw new Error(
      "The applied overlay changed after its target-validation receipt.",
    );
  const expectedBinding = validationBinding(input.apply);
  const expectedAttempt = createTargetValidationAttempt(
    input.apply,
    input.validation.validatedByCallId,
  );
  if (
    input.validation.version !== 3 ||
    input.validation.status !== "passed" ||
    input.validation.attemptDigest !== expectedAttempt.digest ||
    input.validation.applyDigest !== input.apply.digest ||
    input.validation.appSpecPath !== input.apply.appSpecPath ||
    Object.entries(expectedBinding).some(([key, value]) => {
      const observed = input.validation[key as keyof typeof expectedBinding];
      return Array.isArray(value)
        ? JSON.stringify(observed) !== JSON.stringify(value)
        : observed !== value;
    }) ||
    input.validation.commands.length !== expectedAttempt.commands.length ||
    input.validation.commands.some((command, index) => {
      const expected = expectedAttempt.commands[index];
      return (
        expected === undefined ||
        command.name !== expected.name ||
        command.command !== expected.command ||
        command.validationRoot !== expected.validationRoot ||
        command.inputTreeDigest !== input.apply.postTreeDigest ||
        command.exitCode !== 0 ||
        !validDigest(command.stdoutDigest) ||
        !validDigest(command.stderrDigest)
      );
    })
  )
    throw new Error(
      "A canonical V3 target validation receipt for the exact apply is required.",
    );
  const canonicalCommands = input.validation.commands.map((command, index) => {
    const expected = expectedAttempt.commands[index];
    if (expected === undefined)
      throw new Error(
        "A canonical V3 target validation receipt for the exact apply is required.",
      );
    return {
      name: expected.name,
      command: expected.command,
      validationRoot: expected.validationRoot,
      inputTreeDigest: input.apply.postTreeDigest,
      exitCode: 0,
      stdoutDigest: command.stdoutDigest,
      stderrDigest: command.stderrDigest,
    };
  });
  const unsigned = {
    version: 3 as const,
    ...expectedBinding,
    status: "passed" as const,
    attemptDigest: input.validation.attemptDigest,
    commands: canonicalCommands,
    validatedByCallId: input.validation.validatedByCallId,
  };
  if (
    !validDigest(input.validation.attemptDigest) ||
    input.validation.digest !== sha256(JSON.stringify(unsigned)) ||
    JSON.stringify(input.validation) !==
      JSON.stringify({
        ...unsigned,
        digest: sha256(JSON.stringify(unsigned)),
      })
  )
    throw new Error(
      "The canonical V3 target validation receipt digest is malformed.",
    );
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
    appId: apply.targetReceipt.appId,
    testShards: SUPPORTED_VALIDATION_TEST_SHARDS,
    appValidationSha256: ARRUSTED_APP_VALIDATION_SHA256,
    sourceSha: apply.sourceSha,
    sourceTree: apply.sourceTree,
    eligibilityDigest: apply.eligibilityDigest,
    workspaceDigest: apply.workspaceDigest,
    appSpecDigest: apply.appSpecDigest,
    appSpecPath: apply.appSpecPath,
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
  assertCurrentTargetApplyReceipt(apply);
  if (
    apply.applyRoot !== `/workspace/${applyOverlayRoot(apply.proposalDigest)}`
  )
    throw new Error("The target apply overlay root is not proposal-bound.");
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
      validationRoot: validationOverlayRoot(apply.digest, name),
    })),
    startedByCallId,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}

function assertAttemptMatchesApply(
  attempt: TargetValidationAttemptReceipt,
  apply: TargetApplyReceipt,
): void {
  assertCurrentTargetApplyReceipt(apply);
  if (attempt.version !== 3)
    throw new Error("A canonical V3 target validation attempt is required.");
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
    appId: attempt.appId,
    testShards: attempt.testShards,
    appValidationSha256: attempt.appValidationSha256,
    sourceSha: attempt.sourceSha,
    sourceTree: attempt.sourceTree,
    eligibilityDigest: attempt.eligibilityDigest,
    workspaceDigest: attempt.workspaceDigest,
    appSpecDigest: attempt.appSpecDigest,
    appSpecPath: attempt.appSpecPath,
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
  return async ({ sandbox, appId, command, validationRoot }) => {
    const expected = supportedValidationCommands(
      appId,
      SUPPORTED_VALIDATION_TEST_SHARDS,
    ).find((candidate) => candidate.command === command);
    if (expected === undefined)
      throw new Error("The target validation command was not canonical.");
    return await sandbox.run({
      command: command.replace(
        /^mise run /u,
        "MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder run --no-deps --skip-tools ",
      ),
      workingDirectory: validationRoot,
      abortSignal: AbortSignal.timeout(TARGET_VALIDATION_TIMEOUT_MS),
    });
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
  if (input.appId !== input.attempt.appId)
    throw new Error("The validation application id changed after approval.");
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
