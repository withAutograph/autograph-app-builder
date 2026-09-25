import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import {
  supportedValidationCommands,
  SUPPORTED_VALIDATION_TEST_SHARDS,
} from "./supported-template";
import { ARRUSTED_APP_VALIDATION_SHA256 } from "./dependency-cache";
import type { ExecutionDependencyLayout } from "./dependency-cache";
import type { ApplyCommandResult, TargetApplyReceipt } from "./target-apply";

export type TargetValidationCommand =
  | `mise run --skip-tools app:check ${string}`
  | `mise run --skip-tools app:test ${string} ${string}`;
export type TargetValidationCommandName = "check-build" | "test";

export type ValidationCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  command: TargetValidationCommand;
  validationRoot: string;
}) => Promise<ApplyCommandResult>;

interface TargetValidationBinding {
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
}

export interface PlannedValidationCommand {
  name: TargetValidationCommandName;
  command: TargetValidationCommand;
  validationRoot: string;
}

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
  diagnostics?: readonly TargetValidationDiagnostic[];
  output?: TargetValidationOutputExcerpt;
  commandFailure?: {
    name: TargetValidationCommandName;
    exitCode: number;
    hint?: string;
  };
  digest: string;
};

export interface TargetValidationOutputExcerpt {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface TargetValidationDiagnostic {
  code: `TS${number}` | "VITEST";
  path: string;
  line: number;
  column: number;
  message: string;
}

export type TargetValidationResult =
  | { ok: true; receipt: TargetValidationReceipt }
  | { ok: false; receipt: TargetValidationFailureReceipt };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const VALIDATION_OUTPUT_LIMIT = 6000;
const ansiPattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const sensitiveAssignmentPattern =
  /(?<name>authorization|cookie|password|passwd|secret|token|api[-_]?key)(?<separator>\s*[:=]\s*)(?<value>[^\s,;]+)/giu;
const bearerPattern = /Bearer\s+[^\s,;]+/giu;
const repairLinePattern =
  /(?:^|\s)(?:apps\/|error(?:\s+TS\d+|:)|typescript\(TS\d+\)|FAIL\s|Build failed|Failed to compile|Module not found|Cannot find (?:module|name)|Script not found|Formatting issues found)/iu;

// Keep enough compiler/build output for an agent to repair its own candidate,
// while excluding control bytes and common credential forms from durable state.
export const validationOutputExcerpt = (
  stdout: string,
  stderr: string,
): TargetValidationOutputExcerpt => {
  let truncated = false;
  const sanitize = (value: string) => {
    const cleaned = value
      .replaceAll(ansiPattern, "")
      .replaceAll(/[^\t\n\r\u0020-\u007E]/gu, "")
      .replaceAll(bearerPattern, "Bearer [REDACTED]")
      .replaceAll(sensitiveAssignmentPattern, "$<name>$<separator>[REDACTED]")
      .replaceAll(/(?:\/workspace\/repository\/)?(?=apps\/)/gu, "")
      .split("\n")
      .filter((line) => repairLinePattern.test(line))
      .join("\n")
      .trim();
    if (cleaned.length <= VALIDATION_OUTPUT_LIMIT) {
      return cleaned;
    }
    truncated = true;
    return `${cleaned.slice(0, VALIDATION_OUTPUT_LIMIT)}\n[output truncated]`;
  };
  return { stderr: sanitize(stderr), stdout: sanitize(stdout), truncated };
};

const compilerDiagnosticPatterns = [
  /^(?<file>.*?)\((?<line>\d+),(?<column>\d+)\):\s*error\s+(?<code>TS\d+):\s*(?<message>.+)$/u,
  /^(?<file>.*?):(?<line>\d+):(?<column>\d+)\s*-\s*error\s+(?<code>TS\d+):\s*(?<message>.+)$/u,
] as const;
const oxcCompilerHeaderPattern = /^\s*x\s+typescript\((?<code>TS\d+)\):\s*(?<message>.+)$/u;
const sourceLocationPattern = /^\s*,-\[(?<path>.+?):(?<line>\d+):(?<column>\d+)\]$/u;
const vitestFailurePattern = /^\s*FAIL\s+(?<file>.+?)\s*>\s*(?<message>.+)$/u;
const vitestLocationPattern = /^\s*❯\s+(?<path>.+?):(?<line>\d+):(?<column>\d+)$/u;

const safeDiagnosticPath = (value: string): string | undefined => {
  const normalized = value.replaceAll("\\", "/");
  const appsOffset = normalized.indexOf("apps/");
  const path = appsOffset === -1 ? normalized : normalized.slice(appsOffset);
  if (
    path.length === 0 ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !/^[A-Za-z0-9._@/-]+$/u.test(path)
  ) {
    return undefined;
  }
  return path;
};

const diagnosticMessage = (code: TargetValidationDiagnostic["code"]): string => {
  // Command text may contain source literals or credentials. Keep the actual
  // compiler code and location, but generate the explanation ourselves.
  if (code === "VITEST") {
    return "Test assertion failed at this location.";
  }
  if (code === "TS2304" || code === "TS2593") {
    return "A referenced name is missing; inspect its declaration or import.";
  }
  if (code === "TS2532" || code === "TS18048") {
    return "A value may be undefined; handle the empty case.";
  }
  return "Compiler error at this location; inspect the reported code and file.";
};

export const compilerDiagnostics = (output: string): TargetValidationDiagnostic[] => {
  const diagnostics: TargetValidationDiagnostic[] = [];
  const seen = new Set<string>();
  let pendingCompiler: { code: `TS${number}` } | undefined;
  let pendingVitestMessage = false;
  const append = (
    code: TargetValidationDiagnostic["code"],
    pathValue: string,
    lineValue: string,
    columnValue: string,
  ) => {
    const path = safeDiagnosticPath(pathValue);
    const line = Number(lineValue);
    const column = Number(columnValue);
    if (path === undefined || !Number.isSafeInteger(line) || !Number.isSafeInteger(column)) {
      return false;
    }
    const diagnostic = {
      code,
      column,
      line,
      message: diagnosticMessage(code),
      path,
    };
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key) && diagnostics.length < 50) {
      diagnostics.push(diagnostic);
    }
    seen.add(key);
    return true;
  };
  for (const sourceLine of output
    .replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
    .split("\n")) {
    const oxcHeader = oxcCompilerHeaderPattern.exec(sourceLine);
    if (oxcHeader !== null) {
      pendingCompiler = {
        code: oxcHeader[1] as `TS${number}`,
      };
      continue;
    }
    const location = sourceLocationPattern.exec(sourceLine);
    if (location !== null && pendingCompiler !== undefined) {
      append(pendingCompiler.code, location[1], location[2], location[3]);
      pendingCompiler = undefined;
      continue;
    }
    const vitestFailure = vitestFailurePattern.exec(sourceLine);
    if (vitestFailure !== null) {
      pendingVitestMessage = true;
      continue;
    }
    const vitestLocation = vitestLocationPattern.exec(sourceLine);
    if (vitestLocation !== null && pendingVitestMessage) {
      const recorded = append("VITEST", vitestLocation[1], vitestLocation[2], vitestLocation[3]);
      if (recorded) {
        pendingVitestMessage = false;
      }
      continue;
    }
    for (const pattern of compilerDiagnosticPatterns) {
      const match = pattern.exec(sourceLine);
      if (match === null) {
        continue;
      }
      if (/^TS\d+$/u.test(match[4])) {
        append(match[4] as `TS${number}`, match[1], match[2], match[3]);
      }
      break;
    }
  }
  return diagnostics;
};

export const validationBinding = (apply: TargetApplyReceipt): TargetValidationBinding => ({
  appId: apply.targetReceipt.appId,
  appSpecDigest: apply.appSpecDigest,
  appSpecPath: apply.appSpecPath,
  appValidationSha256: ARRUSTED_APP_VALIDATION_SHA256,
  appliedTreeDigest: apply.postTreeDigest,
  applyDigest: apply.digest,
  artifactRevision: apply.artifactRevision,
  changedContentDigest: apply.changedContentDigest,
  dependencyCacheContentDigest: apply.dependencyCacheContentDigest,
  dependencyCacheDigest: apply.dependencyCacheDigest,
  dependencyReceiptDigest: apply.dependencyReceiptDigest,
  eligibilityDigest: apply.eligibilityDigest,
  identityDigest: apply.identityDigest,
  imageDigest: apply.imageDigest,
  proposalDigest: apply.proposalDigest,
  sourceReceiptDigest: apply.sourceReceiptDigest,
  sourceSha: apply.sourceSha,
  sourceTree: apply.sourceTree,
  testShards: SUPPORTED_VALIDATION_TEST_SHARDS,
  workspaceDigest: apply.workspaceDigest,
});

export const createTargetValidationAttempt = (
  apply: TargetApplyReceipt,
  startedByCallId: string,
): TargetValidationAttemptReceipt => {
  const unsigned = {
    status: "pending" as const,
    version: 3 as const,
    ...validationBinding(apply),
    commands: supportedValidationCommands(
      apply.targetReceipt.appId,
      SUPPORTED_VALIDATION_TEST_SHARDS,
    ).map(({ command, name }) => ({
      command,
      name,
      validationRoot: apply.applyRoot,
    })),
    startedByCallId,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
};

const attemptBinding = (attempt: TargetValidationAttemptReceipt): TargetValidationBinding => ({
  appId: attempt.appId,
  appSpecDigest: attempt.appSpecDigest,
  appSpecPath: attempt.appSpecPath,
  appValidationSha256: attempt.appValidationSha256,
  appliedTreeDigest: attempt.appliedTreeDigest,
  applyDigest: attempt.applyDigest,
  artifactRevision: attempt.artifactRevision,
  changedContentDigest: attempt.changedContentDigest,
  dependencyCacheContentDigest: attempt.dependencyCacheContentDigest,
  dependencyCacheDigest: attempt.dependencyCacheDigest,
  dependencyReceiptDigest: attempt.dependencyReceiptDigest,
  eligibilityDigest: attempt.eligibilityDigest,
  identityDigest: attempt.identityDigest,
  imageDigest: attempt.imageDigest,
  proposalDigest: attempt.proposalDigest,
  sourceReceiptDigest: attempt.sourceReceiptDigest,
  sourceSha: attempt.sourceSha,
  sourceTree: attempt.sourceTree,
  testShards: attempt.testShards,
  workspaceDigest: attempt.workspaceDigest,
});

export const sandboxValidationCommandExecutor =
  (): ValidationCommandExecutor =>
  async ({ sandbox, appId, command, validationRoot }) => {
    if (!supportedValidationCommands(appId).some((planned) => planned.command === command)) {
      throw new Error("The repository validation command is not supported.");
    }
    return await sandbox.run({ command, workingDirectory: validationRoot });
  };

export const fixtureValidationCommandExecutor =
  (): ValidationCommandExecutor =>
  ({ appId, command }) => {
    if (
      appId === "validation-interruption" &&
      command.startsWith("mise run --skip-tools app:check ")
    ) {
      const error = new Error("fixture validation interruption");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }
    return Promise.resolve(
      appId === "validation-failure" && command.startsWith("mise run --skip-tools app:check ")
        ? { exitCode: 1, stderr: "fixture validation failure", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: `${command} passed` },
    );
  };

const failureReceipt = (
  attempt: TargetValidationAttemptReceipt,
  commands: readonly TargetValidationCommandReceipt[],
  reason: TargetValidationFailureReason,
  commandFailure?: TargetValidationFailureReceipt["commandFailure"],
  diagnostics?: readonly TargetValidationDiagnostic[],
  output?: TargetValidationOutputExcerpt,
): TargetValidationFailureReceipt => {
  const unsigned = {
    version: 3 as const,
    ...attemptBinding(attempt),
    attemptDigest: attempt.digest,
    commands,
    reason,
    recoveryRequired: true as const,
    status: "failed" as const,
    validatedByCallId: attempt.startedByCallId,
    ...(commandFailure === undefined ? {} : { commandFailure }),
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
    ...(output === undefined ? {} : { output }),
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
};

export const executeProposalBoundValidation = (input: {
  sandbox: SandboxSession;
  executor: ValidationCommandExecutor;
  apply: TargetApplyReceipt;
  attempt: TargetValidationAttemptReceipt;
  dependencyLayout?: ExecutionDependencyLayout;
  appId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<TargetValidationResult> => {
  const commands: TargetValidationCommandReceipt[] = [];
  const execute = async (index: number): Promise<TargetValidationResult> => {
    const planned = input.attempt.commands[index];
    if (planned === undefined) {
      const unsigned = {
        version: 3 as const,
        ...attemptBinding(input.attempt),
        attemptDigest: input.attempt.digest,
        commands,
        status: "passed" as const,
        validatedByCallId: input.attempt.startedByCallId,
      };
      return {
        ok: true,
        receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
      };
    }
    let result: ApplyCommandResult;
    try {
      result = await input.executor({
        appId: input.appId,
        command: planned.command,
        sandbox: input.sandbox,
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
      exitCode: result.exitCode,
      inputTreeDigest: input.apply.postTreeDigest,
      stderrDigest: sha256(result.stderr),
      stdoutDigest: sha256(result.stdout),
    };
    commands.push(commandReceipt);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          "command-failed",
          {
            exitCode: result.exitCode,
            name: planned.name,
            ...(/(?:script not found|missing script|task .* not found)/iu.test(
              `${result.stderr}\n${result.stdout}`,
            )
              ? {
                  hint: "The repository app task is unavailable. Check the supported mise task and app package scripts before retrying.",
                }
              : {}),
          },
          compilerDiagnostics(`${result.stderr}\n${result.stdout}`),
          validationOutputExcerpt(result.stdout, result.stderr),
        ),
      };
    }
    return execute(index + 1);
  };
  return execute(0);
};
