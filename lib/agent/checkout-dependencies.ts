import { createHash, randomUUID } from "node:crypto";
import type { SandboxProcess, SandboxSession } from "eve/sandbox";

import { workspaceBinInstallCommand } from "../repository/workspace-bin-install";
import { ValidationLogWriter } from "../repository/validation-log";
import type { ValidationLogReference, ValidationLogStore } from "../repository/validation-log";
import { sanitizeValidationDiagnosticText } from "../repository/validation-output-sanitize";
import type { TargetValidationFailureReceipt } from "../repository/target-validation";

const bunInstallCommand = "bun install";
const bunFrozenInstallCommand = "bun install --frozen-lockfile";
const dependencyInstallOperation = "dependency-install";

export interface DependencyAttemptResult {
  attemptDigest: string;
  command: "dependency-probe" | "dependency-install";
  executionCommand: string;
  /** Exact Sandbox command hash when the displayed install recipe runs inside the mode-preserving wrapper. */
  dispatchedCommandDigest?: string;
  exitCode: number | null;
  completion: "pending" | "complete" | "interrupted";
  excerpt: string;
  truncated: boolean;
  durability: "available" | "unavailable";
  logs: { stdout?: ValidationLogReference; stderr?: ValidationLogReference };
  /** Exact failed command and its original durable logs; never an approval or source gate. */
  recoveryOfValidationFailure?: TargetValidationFailureReceipt;
}

interface DependencyRecoveryInput {
  sandbox: Pick<SandboxSession, "spawn">;
  root: string;
  sessionId: string;
  checkoutIdentity: string;
  signal?: AbortSignal;
  requiredExecutable?: string;
  /** Authored workspace manifests may legitimately require a package-manager lockfile update. */
  reconcileWorkspace?: boolean;
  logStore?: ValidationLogStore;
  onAttempt?: (attempt: DependencyAttemptResult) => void | Promise<void>;
  assertCurrent?: () => void;
}
interface DependencyExecution {
  exitCode: number | null;
  completion: "complete" | "interrupted";
  failure?: Error;
}

const drain = async (
  stream: ReadableStream<Uint8Array>,
  writer: ValidationLogWriter,
  stopSignal: AbortSignal,
) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const cancel = async () => {
    try {
      await reader.cancel();
    } catch {
      /* A disconnected provider may also reject cancellation. */
    }
  };
  const onStop = () => {
    void cancel();
  };
  stopSignal.addEventListener("abort", onStop, { once: true });
  if (stopSignal.aborted) {
    onStop();
  }
  try {
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Awaited sanitized writes apply backpressure.
      const next = await reader.read();
      if (next.done) {
        break;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Never accumulate complete command output.
      await writer.append(decoder.decode(next.value, { stream: true }));
    }
  } finally {
    stopSignal.removeEventListener("abort", onStop);
    try {
      await writer.append(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
};

const captureProcess = async (
  input: DependencyRecoveryInput,
  command: string,
  stdout: ValidationLogWriter,
  stderr: ValidationLogWriter,
): Promise<DependencyExecution> => {
  const execution: DependencyExecution = { completion: "complete", exitCode: null };
  let process: SandboxProcess | undefined;
  let cleanupStarted = false;
  const stopped = new AbortController();
  const waitInterrupted = Promise.withResolvers<null>();
  const kill = async () => {
    try {
      await process?.kill();
    } catch {
      /* Provider interruption may also prevent process cleanup. */
    }
  };
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalize untrusted provider exceptions before diagnostics.
  const interrupt = (error: unknown) => {
    execution.completion = "interrupted";
    stopped.abort();
    waitInterrupted.resolve(null);
    execution.failure ??=
      error instanceof Error ? error : new Error("The sandbox provider returned no detail.");
    if (!cleanupStarted) {
      cleanupStarted = true;
      // Capture must finish even if the disconnected provider never acknowledges cleanup.
      void kill();
    }
  };
  const observe = async (work: () => PromiseLike<void>) => {
    try {
      await work();
    } catch (error) {
      interrupt(error);
    }
  };
  const onAbort = () => {
    interrupt(input.signal?.reason ?? new Error("Dependency command cancelled."));
  };
  try {
    input.signal?.throwIfAborted();
    input.assertCurrent?.();
    const options = { command, workingDirectory: input.root };
    process = await input.sandbox.spawn(
      input.signal === undefined ? options : { ...options, abortSignal: input.signal },
    );
    const running = process;
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) {
      onAbort();
    }
    // Settle consumers before finalizing; reader cancellation does not depend on provider cleanup.
    await Promise.all([
      observe(async () => {
        await drain(running.stdout, stdout, stopped.signal);
      }),
      observe(async () => {
        await drain(running.stderr, stderr, stopped.signal);
      }),
      observe(async () => {
        const result = await Promise.race([running.wait(), waitInterrupted.promise]);
        if (result !== null) {
          execution.exitCode = result.exitCode;
        }
      }),
    ]);
  } catch (error) {
    interrupt(error);
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
  return execution;
};

const dependencyDispatch = (
  root: string,
  command: DependencyAttemptResult["command"],
  executionCommand: string,
) => {
  if (command === "dependency-probe") {
    return { sandboxCommand: executionCommand, provenance: {} };
  }
  if (executionCommand !== bunInstallCommand && executionCommand !== bunFrozenInstallCommand) {
    throw new Error("The checkout dependency install recipe is unsupported.");
  }
  const sandboxCommand = workspaceBinInstallCommand(
    root,
    executionCommand === bunFrozenInstallCommand,
  );
  return {
    sandboxCommand,
    provenance: {
      dispatchedCommandDigest: createHash("sha256").update(sandboxCommand).digest("hex"),
    },
  };
};

const dependencyAttempt = async (
  input: DependencyRecoveryInput,
  command: DependencyAttemptResult["command"],
  executionCommand: string,
  recoveryOfValidationFailure?: TargetValidationFailureReceipt,
) => {
  const { sandboxCommand, provenance } = dependencyDispatch(input.root, command, executionCommand);
  const attemptDigest = createHash("sha256")
    .update(
      JSON.stringify({
        checkoutIdentity: input.checkoutIdentity,
        command,
        ...provenance,
        executionAttempt: randomUUID(),
        executionCommand,
        root: input.root,
        sessionId: input.sessionId,
      }),
    )
    .digest("hex");
  const writer = (channel: "stdout" | "stderr") =>
    new ValidationLogWriter(
      input.logStore,
      { attemptDigest, channel, command, sessionId: input.sessionId },
      { bestEffort: true, excerptLimit: 2400 },
    );
  const stdout = writer("stdout");
  const stderr = writer("stderr");
  if (recoveryOfValidationFailure !== undefined) {
    // Retain dispatch provenance before execution; pending is an intent,
    // not a fabricated command result or a gate on a later ordinary retry.
    await input.onAttempt?.({
      attemptDigest,
      command,
      completion: "pending",
      durability: "unavailable",
      excerpt: "",
      executionCommand,
      ...provenance,
      exitCode: null,
      logs: {},
      recoveryOfValidationFailure,
      truncated: false,
    });
  }
  const execution = await captureProcess(input, sandboxCommand, stdout, stderr);
  const [out, err] = await Promise.all([
    stdout.finishCapture(execution.completion),
    stderr.finishCapture(execution.completion),
  ]);
  const combined = [err.excerpt, out.excerpt].filter(Boolean).join("\n");
  const logs: DependencyAttemptResult["logs"] = {};
  if (out.reference !== undefined) {
    logs.stdout = out.reference;
  }
  if (err.reference !== undefined) {
    logs.stderr = err.reference;
  }
  const attempt: DependencyAttemptResult = {
    attemptDigest,
    command,
    completion: execution.completion,
    durability:
      out.durability === "available" && err.durability === "available"
        ? "available"
        : "unavailable",
    excerpt: combined.slice(0, 2400),
    executionCommand,
    ...provenance,
    exitCode: execution.exitCode,
    logs,
    truncated: out.omitted || err.omitted || combined.length > 2400,
  };
  if (recoveryOfValidationFailure !== undefined) {
    attempt.recoveryOfValidationFailure = recoveryOfValidationFailure;
  }
  // Persist references before any failure is surfaced to the workflow.
  await input.onAttempt?.(attempt);
  if (
    attempt.completion === "interrupted" ||
    (command === dependencyInstallOperation && attempt.exitCode !== 0)
  ) {
    const cause =
      attempt.excerpt ||
      sanitizeValidationDiagnosticText(execution.failure?.message ?? "No diagnostic output.").slice(
        0,
        2400,
      );
    const status =
      attempt.completion === "interrupted"
        ? "was interrupted"
        : `exited with status ${attempt.exitCode}`;
    throw new Error(
      `Builder could not restore repository dependencies in ${input.root}: '${executionCommand}' ${status}. Check the lockfile, package resolution, network access, and sandbox free space. Read saved dependency log pages before diagnosing truncated output, then retry. Durability: ${attempt.durability}. Cause: ${cause}\nDependency attempt: ${JSON.stringify(attempt)}`,
      { cause: execution.failure },
    );
  }
  return attempt;
};

const hasUnresolvedPackage = (output: string): boolean => {
  const messages = output.matchAll(
    /(?:cannot find (?:module|package)|(?:unable to|could not|failed to|can't|cannot) resolve)\b[\t :]*(?<specifier>[^\r\n]*)/giu,
  );
  for (const message of messages) {
    const remainder = message.groups?.specifier ?? "";
    // Parse the specifier separately: optional diagnostic nouns must never
    // backtrack into a package name when the actual import is a source path.
    const specifier =
      remainder
        .replace(/^(?:module(?: specifier)?|package)\b[\t :]*/iu, "")
        .replace(/^["'`]/u, "")
        .split(/["'`\s]/u, 1)[0] ?? "";
    if (
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._/-]+)?$/iu.test(specifier)
    ) {
      return true;
    }
  }
  return false;
};

/** One native install per invocation; only a successful repair suppresses repeats. */
export const repairCheckoutDependenciesAfterValidationFailure = async (
  input: DependencyRecoveryInput & {
    failure: TargetValidationFailureReceipt;
    attempts: readonly DependencyAttemptResult[];
    assertCurrent: () => void;
    prepareInstall: () => Promise<void>;
    onAttempt: (attempt: DependencyAttemptResult) => void | Promise<void>;
  },
): Promise<void> => {
  const { failure } = input;
  if (
    failure.reason !== "command-failed" ||
    failure.commandFailure === undefined ||
    failure.commandFailure.exitCode <= 0 ||
    !hasUnresolvedPackage(`${failure.output?.stderr ?? ""}\n${failure.output?.stdout ?? ""}`)
  ) {
    return;
  }
  const alreadyRepaired = input.attempts.some((attempt) => {
    if (
      attempt.command !== dependencyInstallOperation ||
      attempt.completion !== "complete" ||
      attempt.exitCode !== 0
    ) {
      return false;
    }
    return (
      attempt.recoveryOfValidationFailure?.digest === failure.digest &&
      attempt.recoveryOfValidationFailure.attemptDigest === failure.attemptDigest
    );
  });
  if (alreadyRepaired) {
    return;
  }
  input.signal?.throwIfAborted();
  input.assertCurrent();
  await input.prepareInstall();
  input.signal?.throwIfAborted();
  input.assertCurrent();
  await dependencyAttempt(input, dependencyInstallOperation, bunInstallCommand, failure);
  input.signal?.throwIfAborted();
  input.assertCurrent();
};

const checkoutDependencyDirectoryProbe = "test -d node_modules/.bin";

/** Reconcile authored workspaces, or restore a frozen checkout missing its dependencies. */
export const ensureCheckoutDependencies = async (
  input: DependencyRecoveryInput,
): Promise<{ status: "reused" | "installed"; attempts: readonly DependencyAttemptResult[] }> => {
  if (
    input.requiredExecutable !== undefined &&
    !/^[A-Za-z0-9_-]{1,80}$/u.test(input.requiredExecutable)
  ) {
    throw new Error("The required repository executable name is invalid.");
  }
  if (input.reconcileWorkspace === true) {
    const install = await dependencyAttempt(input, dependencyInstallOperation, bunInstallCommand);
    input.signal?.throwIfAborted();
    input.assertCurrent?.();
    return { attempts: [install], status: "installed" };
  }
  const probe = await dependencyAttempt(
    input,
    "dependency-probe",
    input.requiredExecutable === undefined
      ? checkoutDependencyDirectoryProbe
      : `test -x node_modules/.bin/${input.requiredExecutable}`,
  );
  const attempts = [probe];
  if (probe.exitCode === 0) {
    return { attempts, status: "reused" };
  }
  attempts.push(
    await dependencyAttempt(input, dependencyInstallOperation, bunFrozenInstallCommand),
  );
  return { attempts, status: "installed" };
};
