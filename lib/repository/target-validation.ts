import { createHash } from "node:crypto";
import { localRuntimeEnvironmentPath } from "./runtime-environment";
import type { PreparedRuntimeExecution } from "../agent/prepared-runtime-execution";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import {
  supportedValidationCommands,
  SUPPORTED_VALIDATION_TEST_SHARDS,
} from "./supported-template";
import { ARRUSTED_APP_VALIDATION_SHA256 } from "./dependency-cache";
import type { ExecutionDependencyLayout } from "./dependency-cache";
import type { ApplyCommandResult, TargetApplyReceipt } from "./target-apply";
import { ValidationLogWriter } from "./validation-log";
import type {
  ValidationLogChannel,
  ValidationLogReference,
  ValidationLogStore,
} from "./validation-log";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

export { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

export type TargetValidationCommand =
  | `mise run --skip-tools app:check ${string}`
  | `mise run --skip-tools app:test ${string} ${string}`;
export type TargetValidationCommandName = "check-build" | "test";

export type ValidationCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  command: TargetValidationCommand;
  validationRoot: string;
  onChunk?: (channel: ValidationLogChannel, content: string) => Promise<void>;
  abortSignal?: AbortSignal;
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
  logs?: { stdout: ValidationLogReference; stderr: ValidationLogReference };
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
    operation?: "run-validation-command";
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

const ansiPattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const sensitiveAssignmentPattern =
  /(?<name>authorization|cookie|password|passwd|secret|token|api[-_]?key)(?<separator>\s*[:=]\s*)(?<value>[^\s,;]+)/giu;
const bearerPattern = /Bearer\s+[^\s,;]+/giu;
const credentialUrlPattern = /(?<scheme>https?:\/\/)[^\s/@]+:[^\s/@]+@/giu;
const credentialPrefixPattern =
  /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu;
const repairLinePattern =
  /(?:^|\s)(?:apps\/|error(?:\s+TS\d+|:)|typescript\(TS\d+\)|FAIL\s|Build failed|Failed to compile|Module not found|Cannot find (?:module|name)|Script not found|Formatting issues found|stale iteration preimage|schema-compiler:|Schema compilation failed|Schema release generation failed|The schema compiler produced invalid JSON|Compiler output excerpt:|ToolNotFound:|linker\s+[`"']?cc|cue:|cargo:|rustc:|mise(?:\s+ERROR|:)|The compiler produced no diagnostic output|The compiler returned no output|No CUE source location was reported|Install a native C compiler|Install the repository's locked mise tools|Read the compiler error and its CUE file location|Retry:)/iu;
const diagnosticContinuationPattern = /^(?:\s+\S|\s*\^|\s*\||\s*(?:caused by|help|note|retry):)/iu;

// Keep enough compiler/build output for an agent to repair its own candidate,
// while excluding control bytes and common credential forms from durable state.
export const validationOutputExcerpt = (
  stdout: string,
  stderr: string,
): TargetValidationOutputExcerpt => {
  const sanitize = (value: string) => {
    const lines = sanitizeValidationDiagnosticText(value).split("\n");
    const retained = new Set<number>();
    for (const [index, line] of lines.entries()) {
      if (!repairLinePattern.test(line)) continue;
      retained.add(index);
      // CUE and Rust often put the source excerpt or the underlying cause on
      // following lines that do not repeat the error prefix.
      for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
        if (!diagnosticContinuationPattern.test(lines[next] ?? "")) break;
        retained.add(next);
      }
    }
    const cleaned = lines
      .filter((_line, index) => retained.has(index))
      .join("\n")
      .trim();
    return {
      cleaned,
      omitted: lines.some((line, index) => line.trim().length > 0 && !retained.has(index)),
    };
  };
  const safeStdout = sanitize(stdout);
  const safeStderr = sanitize(stderr);
  return {
    stderr: safeStderr.cleaned,
    stdout: safeStdout.cleaned,
    truncated: safeStdout.omitted || safeStderr.omitted,
  };
};

// A provider can throw before it returns a command result. Keep its useful
// message in the durable receipt, without persisting a raw stack or object.
const executionErrorDetail = (error: Error): string => {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof Error) {
      if (current.message.trim().length > 0) {
        messages.push(current.message);
      }
      current = current.cause;
    } else {
      const causeMessage = z.string().safeParse(current);
      if (causeMessage.success) {
        messages.push(causeMessage.data);
      }
      break;
    }
  }
  const cleaned = messages
    .join("; caused by: ")
    .replaceAll(ansiPattern, "")
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(credentialUrlPattern, "$<scheme>[REDACTED]@")
    .replaceAll(bearerPattern, "Bearer [REDACTED]")
    .replaceAll(sensitiveAssignmentPattern, "$<name>$<separator>[REDACTED]")
    .replaceAll(credentialPrefixPattern, "[REDACTED]")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) {
    return "The execution provider returned no error detail.";
  }
  return cleaned;
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
  (options?: { runtime?: PreparedRuntimeExecution | null }): ValidationCommandExecutor =>
  async ({ sandbox, appId, command, validationRoot, onChunk, abortSignal }) => {
    if (!supportedValidationCommands(appId).some((planned) => planned.command === command)) {
      throw new Error("The repository validation command is not supported.");
    }
    // Repository tasks may start local services. Keep those services' output on
    // a file so a child that outlives the task cannot hold the sandbox command
    // pipe open after the validation task exits.
    const runtimeTask = command.includes(" app:check ") ? "repository-check" : "repository-test";
    const shard = command.includes(" app:test ") ? ` ${command.split(" ").at(-1)}` : "";
    if (options?.runtime) {
      return await options.runtime.runTask({
        task: runtimeTask,
        ...(shard ? { shard: shard.trim() } : {}),
        onChunk,
        signal: abortSignal,
      });
    }
    const executionCommand = `if [ -f '${localRuntimeEnvironmentPath(validationRoot, appId)}' ]; then mise run app:runtime run ${appId} ${runtimeTask}${shard}; else ${command}; fi`;
    const detachedCommand = `set +e
log=$(mktemp /tmp/app-builder-validation.XXXXXX) || exit $?
${executionCommand} > "$log" 2>&1
status=$?
cat "$log"
rm -f "$log"
exit "$status"`;
    if (onChunk === undefined) {
      return await sandbox.run({ command: detachedCommand, workingDirectory: validationRoot });
    }
    const process = await sandbox.spawn({
      abortSignal,
      command: executionCommand,
      workingDirectory: validationRoot,
    });
    const drain = async (channel: ValidationLogChannel, stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder("utf-8");
      try {
        while (true) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Durable writes apply output backpressure.
          const next = await reader.read();
          if (next.done) break;
          const content = decoder.decode(next.value, { stream: true });
          if (content) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Each stream read waits for durable storage.
            await onChunk(channel, content);
          }
        }
        const tail = decoder.decode();
        if (tail) await onChunk(channel, tail);
      } finally {
        reader.releaseLock();
      }
    };
    try {
      const results = await Promise.all([
        drain("stdout", process.stdout),
        drain("stderr", process.stderr),
        process.wait(),
      ]);
      const status = results.at(-1);
      if (status === undefined) {
        throw new Error("The validation command did not return an exit status.");
      }
      return { exitCode: status.exitCode, stderr: "", stdout: "" };
    } catch (error) {
      await process.kill();
      throw error;
    }
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
  logStore?: ValidationLogStore;
  sessionId?: string;
  abortSignal?: AbortSignal;
}): Promise<TargetValidationResult> => {
  const commands: TargetValidationCommandReceipt[] = [];
  // oxlint-disable-next-line eslint/complexity -- Existing receipt branches and staged log rollback share one command transition.
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
    const logInput =
      input.logStore === undefined || input.sessionId === undefined
        ? undefined
        : {
            attemptDigest: input.attempt.digest,
            command: planned.name,
            sessionId: input.sessionId,
          };
    const stdoutLog =
      logInput === undefined || input.logStore === undefined
        ? undefined
        : new ValidationLogWriter(input.logStore, { ...logInput, channel: "stdout" });
    const stderrLog =
      logInput === undefined || input.logStore === undefined
        ? undefined
        : new ValidationLogWriter(input.logStore, { ...logInput, channel: "stderr" });
    let durableOutput:
      | {
          stdout: Awaited<ReturnType<ValidationLogWriter["finish"]>>;
          stderr: Awaited<ReturnType<ValidationLogWriter["finish"]>>;
        }
      | undefined;
    try {
      console.info(
        JSON.stringify({
          callId: input.attempt.startedByCallId,
          command: planned.name,
          event: "app_builder.validation_command",
          phase: "started",
        }),
      );
      result = await input.executor({
        abortSignal: input.abortSignal,
        appId: input.appId,
        command: planned.command,
        sandbox: input.sandbox,
        validationRoot: planned.validationRoot,
        ...(stdoutLog === undefined || stderrLog === undefined
          ? {}
          : {
              onChunk: async (channel: ValidationLogChannel, content: string) => {
                await (channel === "stdout" ? stdoutLog : stderrLog).append(content);
              },
            }),
      });
      if (stdoutLog !== undefined && stderrLog !== undefined) {
        // Fixture executors return strings; hosted Sandbox executors stream.
        if (result.stdout) await stdoutLog.append(result.stdout);
        if (result.stderr) await stderrLog.append(result.stderr);
        const stdout = await stdoutLog.finish();
        const stderr = await stderrLog.finish();
        durableOutput = { stderr, stdout };
      }
      console.info(
        JSON.stringify({
          callId: input.attempt.startedByCallId,
          command: planned.name,
          event: "app_builder.validation_command",
          exitCode: result.exitCode,
          phase: "finished",
        }),
      );
    } catch (error) {
      await Promise.allSettled([stdoutLog?.abort(), stderrLog?.abort()]);
      console.warn(
        JSON.stringify({
          callId: input.attempt.startedByCallId,
          command: planned.name,
          errorName: error instanceof Error ? error.name : "non_error_rejection",
          event: "app_builder.validation_command",
          phase: "provider_error",
        }),
      );
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const rejection = z.string().safeParse(error);
      let providerError: Error;
      if (error instanceof Error) {
        providerError = error;
      } else if (rejection.success) {
        providerError = new Error(rejection.data);
      } else {
        providerError = new Error("The provider returned a non-Error rejection.");
      }
      return {
        ok: false,
        receipt: failureReceipt(
          input.attempt,
          commands,
          timedOut ? "command-timeout" : "execution-error",
          {
            exitCode: -1,
            hint: `The execution provider ${timedOut ? "timed out while running" : "could not run"} ${planned.name} (${planned.command}). Cause: ${executionErrorDetail(providerError)} Check the sandbox and command working directory, then retry validation.`,
            name: planned.name,
            operation: "run-validation-command",
          },
        ),
      };
    }
    const commandReceipt = {
      ...planned,
      exitCode: result.exitCode,
      inputTreeDigest: input.apply.postTreeDigest,
      stderrDigest: durableOutput?.stderr.reference.digest ?? sha256(result.stderr),
      stdoutDigest: durableOutput?.stdout.reference.digest ?? sha256(result.stdout),
      ...(durableOutput === undefined
        ? {}
        : {
            logs: {
              stderr: durableOutput.stderr.reference,
              stdout: durableOutput.stdout.reference,
            },
          }),
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
          compilerDiagnostics(
            `${durableOutput?.stderr.excerpt ?? result.stderr}\n${durableOutput?.stdout.excerpt ?? result.stdout}`,
          ),
          durableOutput === undefined
            ? validationOutputExcerpt(result.stdout, result.stderr)
            : {
                stderr: durableOutput.stderr.excerpt,
                stdout: durableOutput.stdout.excerpt,
                truncated: durableOutput.stderr.omitted || durableOutput.stdout.omitted,
              },
        ),
      };
    }
    return execute(index + 1);
  };
  return execute(0);
};
