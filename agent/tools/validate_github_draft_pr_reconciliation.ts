import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { currentDraftCandidateSource } from "@/lib/agent/published-draft-repair";
import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import { createHash, randomUUID } from "node:crypto";
import { publishCompiledOperatorArtifactsForSession } from "@/lib/agent/compiled-operator-artifacts";
import type { ToolContext } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { withCandidateCommandEnvironment } from "@/lib/agent/candidate-command-environment";
import { attachCheckoutDependencyView } from "@/lib/repository/dependency-cache";
import { retireUnusedDraftWorktrees } from "@/lib/repository/retire-unused-draft-worktrees";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appSchemaReleaseCommand, compileAppSchemaRelease } from "./compile-app-schema-release";
import {
  appDeclaresLocalSetup,
  localPreviewExecutionCommand,
  prepareAppLocalPreview,
} from "./prepare-app-local-preview";
import { appBrowserTestCommand, runAppBrowserTests } from "./run-app-browser-tests";
import {
  draftReconciliationCompletions,
  draftReconciliationState,
  retainCandidateValidationAttempt,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import type {
  CandidateValidationAttempt,
  DraftReconciliationCandidate,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { supportedValidationCommands } from "@/lib/repository/supported-template";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import {
  sandboxValidationCommandExecutor,
  readTargetValidationTestShards,
  validationOutputExcerpt,
} from "@/lib/repository/target-validation";
import { ValidationLogWriter } from "@/lib/repository/validation-log";
import type { ValidationLogStore } from "@/lib/repository/validation-log";
import { validationLogStoreForSession } from "@/lib/agent/validation-log-store-for-session";

const publishCandidateArtifacts = async (
  ctx: ToolContext,
  candidate: DraftReconciliationCandidate,
  sandbox: SandboxSession,
) => {
  const state = appBuilderWorkflowState.get();
  if (state.phase !== "reviewed") {
    throw new Error("The reviewed app no longer owns this compilation.");
  }
  return await publishCompiledOperatorArtifactsForSession({
    adapterSessionId: ctx.session.id,
    callbackExecution: hostedOperatorCallbackExecution(ctx.session),
    appId: candidate.appId,
    appSpecDigest: state.appSpec.digest,
    callId: ctx.callId,
    root: candidate.root,
    sandbox,
    sessionAuth: ctx.session.auth,
    signal: ctx.abortSignal,
  });
};

const installCommand = "mise exec --no-deps -- bun install --frozen-lockfile";
const additionalCheckCommand = (task: string) => `mise run --no-deps --skip-tools ${task}`;

type ValidationStep = NonNullable<DraftReconciliationCandidate["validationRun"]>["steps"][number];
const captureCommand = "Capture selected checked app release";

const validationSteps = (input: {
  appId: string;
  root: string;
  sandbox: SandboxSession;
  additionalCheckTasks: string[];
  runBrowserTests: boolean;
  schemaTaskCompleted?: true;
  testShards: readonly string[];
}): ValidationStep[] => {
  const checks: ValidationStep[] = supportedValidationCommands(input.appId, input.testShards, {
    alreadyCompiled: input.schemaTaskCompleted,
  }).map(({ command }) => ({
    command,
    kind: "check",
  }));
  return [
    ...(input.schemaTaskCompleted === true
      ? []
      : [{ command: appSchemaReleaseCommand(input.appId), kind: "schema" as const }]),
    ...checks,
    ...(input.runBrowserTests
      ? [{ command: appBrowserTestCommand(input.appId), kind: "browser" as const }]
      : []),
    ...input.additionalCheckTasks.map((task) => ({
      command: additionalCheckCommand(task),
      kind: "additional" as const,
    })),
    { command: captureCommand, kind: "capture" },
  ];
};

const declaredMissingPackage = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "readTextFile">;
  output: string;
  signal?: AbortSignal;
}): Promise<boolean> => {
  const packageSpecifier =
    /^\s*(?:error: )?Cannot find package ['"](?<name>[^'"]+)['"] (?:from|imported from) /imu.exec(
      input.output,
    )?.groups?.name;
  const specifier = packageSpecifier;
  if (specifier === undefined || specifier.startsWith(".") || specifier.startsWith("/")) {
    return false;
  }
  const name = specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
  if (name !== specifier) {
    return false;
  }
  const manifestSchema = z.looseObject({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
  });
  for (const path of [
    `${input.root}/package.json`,
    `${input.root}/apps/${input.appId}/package.json`,
  ]) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Stop after a positive declaration in the actual repository or selected app manifest.
      const text = await input.sandbox.readTextFile({ path, abortSignal: input.signal });
      if (text === null) {
        continue;
      }
      const manifest = manifestSchema.safeParse(JSON.parse(text));
      if (
        manifest.success &&
        [
          manifest.data.dependencies,
          manifest.data.devDependencies,
          manifest.data.optionalDependencies,
        ].some((entries) => entries !== undefined && Object.hasOwn(entries, name))
      ) {
        return true;
      }
    } catch {
      input.signal?.throwIfAborted();
      // Unreadable dependency evidence leaves the original task failure actionable.
    }
  }
  return false;
};

/** Route positive task diagnostics to closed setup actions, never arbitrary output commands. */
const recoveryStep = async (input: {
  appId: string;
  root: string;
  command: string;
  output: string;
  sandbox: Pick<SandboxSession, "readTextFile">;
  signal?: AbortSignal;
}): Promise<ValidationStep | undefined> => {
  if (
    [
      `${input.appId} must have exactly one checked release matching its CUE source`,
      `apps/${input.appId}/schema/index.ts is required for its checked release`,
      `apps/${input.appId}/schema/index.ts is stale for its checked release`,
    ].some((diagnostic) => input.output.includes(diagnostic))
  ) {
    return {
      kind: "schema",
      command: appSchemaReleaseCommand(input.appId),
      recoveryFor: input.command,
    };
  }
  if (await declaredMissingPackage(input)) {
    return { kind: "install", command: installCommand, recoveryFor: input.command };
  }
  return undefined;
};

const executeCandidateCheck = async (input: {
  planned: ReturnType<typeof supportedValidationCommands>[number];
  candidate: DraftReconciliationCandidate;
  callId: string;
  sessionId: string;
  sessionAuth: unknown;
  resolvedTree: string;
  sandbox: SandboxSession;
  signal?: AbortSignal;
  alreadyCompiled?: true;
  testShards: readonly string[];
}): Promise<Awaited<ReturnType<ReturnType<typeof sandboxValidationCommandExecutor>>>> => {
  const binding = {
    appId: input.candidate.appId,
    baseSha: input.candidate.baseSha,
    callId: input.callId,
    category: input.planned.name,
    command: input.planned.command,
    githubSourceDigest: input.candidate.githubSourceDigest,
    headSha: input.candidate.headSha,
    originalReviewDigest: input.candidate.originalReviewDigest,
    pullRequestNumber: input.candidate.pullRequestNumber,
    repositoryId: input.candidate.repositoryId,
    resolvedTree: input.resolvedTree,
    sessionId: input.sessionId,
    unique: randomUUID(),
  };
  let attemptDigest: string | undefined;
  let store: ValidationLogStore | undefined;
  let writers:
    | {
        stderr: ValidationLogWriter;
        stdout: ValidationLogWriter;
      }
    | undefined;
  try {
    const digest = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
    attemptDigest = digest;
  } catch {
    // Capture identity creation is best effort and cannot prevent the command from running.
  }
  try {
    if (attemptDigest !== undefined) {
      store = await validationLogStoreForSession({
        sessionAuth: input.sessionAuth,
        sessionId: input.sessionId,
      });
      if (store !== undefined) {
        writers = {
          stderr: new ValidationLogWriter(
            store,
            {
              attemptDigest,
              channel: "stderr",
              command: input.planned.name,
              sessionId: input.sessionId,
            },
            { bestEffort: true },
          ),
          stdout: new ValidationLogWriter(
            store,
            {
              attemptDigest,
              channel: "stdout",
              command: input.planned.name,
              sessionId: input.sessionId,
            },
            { bestEffort: true },
          ),
        };
      }
    }
  } catch {
    store = undefined;
    writers = undefined;
  }
  const logs: CandidateValidationAttempt["logs"] = {};
  const finish = async (completion: "complete" | "interrupted", exitCode: number | null) => {
    let durability: CandidateValidationAttempt["durability"] = "unavailable";
    if (writers !== undefined) {
      try {
        const [stdout, stderr] = await Promise.all([
          writers.stdout.finishCapture(completion),
          writers.stderr.finishCapture(completion),
        ]);
        durability =
          stdout.durability === "available" && stderr.durability === "available"
            ? "available"
            : "unavailable";
        if (stdout.reference !== undefined) {
          logs.stdout = stdout.reference;
        }
        if (stderr.reference !== undefined) {
          logs.stderr = stderr.reference;
        }
      } catch {
        durability = "unavailable";
      }
    }
    try {
      if (attemptDigest === undefined) {
        return;
      }
      retainCandidateValidationAttempt({
        attemptDigest,
        appId: binding.appId,
        baseSha: binding.baseSha,
        callId: binding.callId,
        category: binding.category,
        command: binding.command,
        completion,
        durability,
        exitCode,
        githubSourceDigest: binding.githubSourceDigest,
        headSha: binding.headSha,
        logs,
        originalReviewDigest: binding.originalReviewDigest,
        pullRequestNumber: binding.pullRequestNumber,
        repositoryId: binding.repositoryId,
        resolvedTree: binding.resolvedTree,
      });
    } catch {
      // Historical evidence is best effort and never changes the command result.
    }
  };
  try {
    // The executor uses onChunk to switch to spawn; retain its detached run lifecycle and capture its returned output.
    const result = await sandboxValidationCommandExecutor({
      alreadyCompiled: input.alreadyCompiled,
      testShards: input.testShards,
    })({
      appId: input.candidate.appId,
      command: input.planned.command,
      sandbox: input.sandbox,
      validationRoot: input.candidate.root,
      abortSignal: input.signal,
    });
    if (writers !== undefined) {
      try {
        if (result.stdout) {
          await writers.stdout.append(result.stdout);
        }
        if (result.stderr) {
          await writers.stderr.append(result.stderr);
        }
      } catch {
        // Best-effort capture must not affect the command outcome.
      }
    }
    await finish("complete", result.exitCode);
    return result;
  } catch (error) {
    await finish("interrupted", null);
    throw error;
  }
};

/** Keep completed receipts; update only recognized pending repository command forms. */
const currentValidationStep = (
  step: ValidationStep,
  appId: string,
  alreadyCompiled?: true,
  testShards?: readonly string[],
): ValidationStep => {
  switch (step.kind) {
    case "install": {
      return step.command === installCommand ||
        step.command === "mise exec -- bun install --frozen-lockfile"
        ? { ...step, command: installCommand }
        : step;
    }
    case "schema": {
      return { ...step, command: appSchemaReleaseCommand(appId) };
    }
    case "local": {
      return { ...step, command: localPreviewExecutionCommand(appId) };
    }
    case "browser": {
      return { ...step, command: appBrowserTestCommand(appId) };
    }
    case "check": {
      const planned = supportedValidationCommands(appId, testShards, { alreadyCompiled }).find(
        (candidate) => {
          const legacy =
            candidate.name === "check-build"
              ? `mise run --skip-tools app:check ${appId}`
              : `mise run --skip-tools app:test ${appId} ${candidate.command.split(" ").at(-1)}`;
          const standalone = candidate.command.replace("--skip-deps ", "");
          const precompiled = standalone.replace("--skip-tools", "--skip-deps --skip-tools");
          return [candidate.command, standalone, precompiled, legacy].includes(step.command);
        },
      );
      return planned === undefined ? step : { ...step, command: planned.command };
    }
    case "additional": {
      const task = /^mise run (?:--no-deps )?--skip-tools (?<task>check:[A-Za-z0-9:_-]+)$/u.exec(
        step.command,
      )?.groups?.task;
      return task === undefined ? step : { ...step, command: additionalCheckCommand(task) };
    }
    case "capture": {
      return { ...step, command: captureCommand };
    }
    default: {
      return step;
    }
  }
};
interface ValidationStepResult {
  command: string;
  exitCode: number | null;
  status: "passed" | "failed";
  problem?: string;
  output?: ReturnType<typeof validationOutputExcerpt>;
}

const testShardForStep = (step: ValidationStep, appId: string): string | undefined => {
  if (step.kind !== "check") {
    return undefined;
  }
  const shard = / (?<shard>[1-9][0-9]*\/[1-9][0-9]*)$/u.exec(step.command)?.groups?.shard;
  if (shard === undefined) {
    return undefined;
  }
  const normalized = currentValidationStep(step, appId, true, [shard]);
  const planned = supportedValidationCommands(appId, [shard], { alreadyCompiled: true }).find(
    (entry) => entry.name === "test",
  );
  return normalized.command === planned?.command ? shard : undefined;
};

/** Only pending test commands follow the current declaration; completed evidence stays intact. */
const currentValidationSteps = (
  run: NonNullable<DraftReconciliationCandidate["validationRun"]>,
  appId: string,
  testShards: readonly string[],
): ValidationStep[] => {
  const completed = run.steps.slice(0, run.nextIndex);
  const completedShards = new Set(completed.map((step) => testShardForStep(step, appId)));
  const tests: ValidationStep[] = supportedValidationCommands(appId, testShards, {
    alreadyCompiled: run.schemaTaskCompleted,
  })
    .filter((step) => step.name === "test" && !completedShards.has(step.command.split(" ").at(-1)))
    .map(({ command }) => ({ command, kind: "check" }));
  let inserted = false;
  const pending = run.steps.slice(run.nextIndex).flatMap((step) => {
    const isTest = testShardForStep(step, appId) !== undefined;
    const insert =
      !inserted && (isTest || ["browser", "additional", "capture"].includes(step.kind));
    if (insert) {
      inserted = true;
    }
    const current = currentValidationStep(step, appId, run.schemaTaskCompleted, testShards);
    return [...(insert ? tests : []), ...(isTest ? [] : [current])];
  });
  return [...completed, ...pending, ...(inserted ? [] : tests)];
};

/** Eve publishes progress at tool boundaries, so each incremental call runs one command. */
/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity -- Ordered validation branches by command category and recovery outcome. */
const runIncrementalValidation = async (
  input: {
    additionalCheckTasks: string[];
    expectedCommand?: string;
    runBrowserTests: boolean;
  },
  ctx: ToolContext,
  candidate: DraftReconciliationCandidate,
  sandbox: SandboxSession,
) => {
  const before = await inspectDraftReconciliation({ prepared: candidate, sandbox });
  if (before.unresolvedConflicts.length > 0) {
    return {
      conflicts: before.unresolvedConflicts,
      problem: "Resolve every listed app-owned conflict before running candidate checks.",
      status: "needs_resolution" as const,
    };
  }
  const testShards = await readTargetValidationTestShards({
    sandbox,
    root: candidate.root,
    workspacePath: `apps/${candidate.appId}`,
    signal: ctx.abortSignal,
  });
  let run = candidate.validationRun ?? null;
  const checkoutChanged = run !== null && run.resolvedTree !== before.resolvedTree;
  if (checkoutChanged) {
    // An expired/replaced sandbox or a normal source edit invalidates only this validation pass.
    run = null;
  }
  if (run === null) {
    const steps = validationSteps({
      ...input,
      appId: candidate.appId,
      root: candidate.root,
      sandbox,
      testShards,
    });
    run = { commands: [], nextIndex: 0, resolvedTree: before.resolvedTree, steps };
    const initialRun = run;
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "starting command-by-command candidate validation",
      transition: () => {
        const next = { ...candidate, validationRun: initialRun };
        delete next.validation;
        delete next.proposal;
        delete next.review;
        delete next.repairReview;
        delete next.reviewReadProgress;
        return next;
      },
    });
  }
  const originalStep = run.steps[run.nextIndex];
  const originalStepCommand = originalStep?.command;
  const nextIndexToRun = run.nextIndex;
  const schemaTaskCompleted = run.schemaTaskCompleted;
  run = {
    ...run,
    steps: currentValidationSteps(run, candidate.appId, testShards),
  };
  if (!run.steps.some((entry) => entry.kind === "capture")) {
    run = { ...run, steps: [...run.steps, { kind: "capture", command: captureCommand }] };
  }
  const step = run.steps[run.nextIndex];
  if (step === undefined) {
    throw new Error(
      "Candidate validation has no next command. Inspect this saved session and restart validation.",
    );
  }
  if (
    originalStep !== undefined &&
    input.expectedCommand === originalStepCommand &&
    currentValidationStep(originalStep, candidate.appId, schemaTaskCompleted, testShards)
      .command !== step.command
  ) {
    const latest = draftReconciliationState.get();
    if (latest === null) {
      throw new Error("The candidate is unavailable while refreshing its test plan.");
    }
    const refreshed = run;
    updateExactDraftReconciliation({
      expected: latest,
      operation: "refreshing the current declared test plan",
      transition: () => ({ ...latest, validationRun: refreshed }),
    });
    return {
      status: "plan_refreshed" as const,
      nextCommand: step.command,
      passedCommands: run.commands.length,
      remainingCommands: run.steps.length - run.nextIndex,
    };
  }
  if (
    input.expectedCommand !== undefined &&
    input.expectedCommand !== step.command &&
    input.expectedCommand !== originalStepCommand
  ) {
    throw new Error(
      `Candidate validation is ready for ${step.command}, but this call supplied a different command.${checkoutChanged ? " The checkout changed since the prior validation command, so Builder restarted the check sequence." : ""} Resume with the returned nextCommand; no command was run.`,
    );
  }
  let result: ValidationStepResult;
  let recovery: ValidationStep | undefined;
  let compilation = run.compilation;
  try {
    if (step.kind === "capture") {
      try {
        const captured = await publishCandidateArtifacts(ctx, candidate, sandbox);
        compilation = captured.compilation;
      } catch {
        ctx.abortSignal?.throwIfAborted();
        return {
          command: captureCommand,
          exitCode: null,
          problem:
            "The repository checks passed, but Builder could not capture the actual selected checked release under current owner/session authority. Restore artifact storage or session authority and retry this pending capture; no extra schema compilation is required.",
          status: "needs_repair" as const,
        };
      }
      result = { command: captureCommand, exitCode: null, status: "passed" };
    } else if (step.kind === "schema") {
      const schema = await compileAppSchemaRelease({
        appId: candidate.appId,
        root: candidate.root,
        sandbox,
        signal: ctx.abortSignal,
      });
      if (schema.status === "compiled") {
        run = {
          ...run,
          schemaTaskCompleted: true,
          steps: run.steps.map((entry, index) =>
            index > nextIndexToRun
              ? currentValidationStep(entry, candidate.appId, true, testShards)
              : entry,
          ),
        };
      } else {
        const required = await recoveryStep({
          appId: candidate.appId,
          root: candidate.root,
          sandbox,
          signal: ctx.abortSignal,
          command: step.command,
          output: `${schema.stderr}\n${schema.stdout}`,
        });
        recovery = required?.kind === "install" ? required : undefined;
      }
      result = {
        command: schema.command,
        exitCode: schema.exitCode,
        output: validationOutputExcerpt(schema.stdout, schema.stderr),
        problem: schema.status === "failed" ? schema.problem : undefined,
        status: schema.status === "compiled" ? "passed" : "failed",
      };
    } else if (step.kind === "local") {
      const local = await prepareAppLocalPreview({
        appId: candidate.appId,
        root: candidate.root,
        sandbox,
        signal: ctx.abortSignal,
      });
      result = {
        command: local.command,
        exitCode: local.exitCode,
        output: validationOutputExcerpt(local.stdout, local.stderr),
        problem: local.status === "failed" ? local.problem : undefined,
        status: local.status === "prepared" ? "passed" : "failed",
      };
    } else if (step.kind === "browser") {
      const browser = await runAppBrowserTests({
        appId: candidate.appId,
        execution: {
          appId: candidate.appId,
          root: candidate.root,
          sandboxId: getBuilderSandboxId(sandbox),
          sessionAuth: ctx.session.auth,
          sessionId: ctx.session.id,
          signal: ctx.abortSignal,
          state: appBuilderWorkflowState.get(),
        },
        root: candidate.root,
        sandbox,
        signal: ctx.abortSignal,
      });
      result = {
        command: browser.command,
        exitCode: browser.exitCode,
        output: validationOutputExcerpt(browser.stdout, browser.stderr),
        problem: browser.status === "failed" ? browser.problem : undefined,
        status: browser.status === "passed" ? "passed" : "failed",
      };
    } else {
      const planned = supportedValidationCommands(candidate.appId, testShards, {
        alreadyCompiled: run.schemaTaskCompleted,
      }).find(({ command }) => command === step.command);
      if (step.kind === "check" && planned === undefined) {
        throw new Error(`The selected repository check ${step.command} is no longer supported.`);
      }
      const execution =
        step.kind === "check" && planned !== undefined
          ? await executeCandidateCheck({
              candidate,
              callId: ctx.callId,
              planned,
              resolvedTree: before.resolvedTree,
              sandbox,
              sessionAuth: ctx.session.auth,
              sessionId: ctx.session.id,
              signal: ctx.abortSignal,
              alreadyCompiled: run.schemaTaskCompleted,
              testShards,
            })
          : await sandbox.run({
              abortSignal: ctx.abortSignal,
              command: step.command,
              workingDirectory: candidate.root,
            });
      const checkedBuild =
        step.kind === "check" && planned?.name === "check-build" && execution.exitCode === 0;
      if (
        checkedBuild &&
        run.steps[run.nextIndex + 1]?.kind !== "local" &&
        (await appDeclaresLocalSetup({ appId: candidate.appId, root: candidate.root, sandbox }))
      ) {
        run = {
          ...run,
          steps: [
            ...run.steps.slice(0, run.nextIndex + 1),
            { kind: "local", command: localPreviewExecutionCommand(candidate.appId) },
            ...run.steps.slice(run.nextIndex + 1),
          ],
        };
      }
      if (step.kind === "check" && execution.exitCode !== 0) {
        recovery = await recoveryStep({
          appId: candidate.appId,
          root: candidate.root,
          sandbox,
          signal: ctx.abortSignal,
          command: step.command,
          output: `${execution.stderr}\n${execution.stdout}`,
        });
      }
      result = {
        command: step.command,
        exitCode: execution.exitCode,
        output: validationOutputExcerpt(execution.stdout, execution.stderr),
        status: execution.exitCode === 0 ? "passed" : "failed",
      };
    }
  } catch (error) {
    throw new Error(
      `Builder could not run ${step.command} during draft PR candidate validation. Check the private sandbox and repository task, then retry this saved session. Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (result.status === "failed") {
    const completedRecovery = run.steps
      .slice(0, run.nextIndex)
      .filter((entry) => entry.recoveryFor !== undefined);
    if (
      recovery !== undefined &&
      !completedRecovery.some(
        (entry) => entry.kind === recovery?.kind && entry.recoveryFor === recovery.recoveryFor,
      )
    ) {
      const steps = [
        ...completedRecovery,
        recovery,
        ...validationSteps({
          ...input,
          appId: candidate.appId,
          root: candidate.root,
          sandbox,
          schemaTaskCompleted: recovery.kind === "schema" ? true : run.schemaTaskCompleted,
          testShards,
        }),
      ];
      const changed = await inspectDraftReconciliation({ prepared: candidate, sandbox });
      if (changed.unresolvedConflicts.length > 0) {
        return {
          conflicts: changed.unresolvedConflicts,
          problem: "Resolve the listed app-owned conflicts before setup recovery.",
          status: "needs_resolution" as const,
        };
      }
      const recoveryRun = {
        ...run,
        resolvedTree: changed.resolvedTree,
        steps,
        nextIndex: completedRecovery.length,
        compilation: undefined,
        schemaTaskCompleted: recovery.kind === "schema" ? undefined : run.schemaTaskCompleted,
      };
      const latest = draftReconciliationState.get();
      if (latest === null) {
        throw new Error("The candidate is unavailable while recording setup recovery.");
      }
      updateExactDraftReconciliation({
        expected: latest,
        operation: "recording setup required by a failed repository command",
        transition: () => ({ ...latest, validationRun: recoveryRun }),
      });
      return {
        command: result.command,
        exitCode: result.exitCode,
        output: result.output,
        nextCommand: recovery.command,
        passedCommands: run.commands.length,
        remainingCommands: steps.length - completedRecovery.length,
        problem: `The repository command failed and reported a concrete setup repair. Run the returned fixed nextCommand, then rerun the repository checks.`,
        status: "in_progress" as const,
      };
    }
    return {
      command: result.command,
      exitCode: result.exitCode,
      output: result.output,
      problem:
        result.problem ??
        `The reconciled checkout failed ${step.command}. Read the command output, repair the named repository task or source, then restart candidate validation.`,
      status: "needs_repair" as const,
    };
  }
  const after = await inspectDraftReconciliation({ prepared: candidate, sandbox });
  if (after.unresolvedConflicts.length > 0) {
    return {
      conflicts: after.unresolvedConflicts,
      problem: `After ${step.command}, the checkout has unresolved conflicts. Resolve the listed app-owned files, then restart validation.`,
      status: "needs_resolution" as const,
    };
  }
  const commands =
    step.kind === "capture"
      ? run.commands
      : [...run.commands, { command: step.command, exitCode: 0 }];
  const latest = draftReconciliationState.get();
  if (latest === null) {
    throw new Error("The candidate is unavailable while recording validation progress.");
  }
  const nextIndex = run.nextIndex + 1;
  if (nextIndex < run.steps.length) {
    const nextRun = { ...run, commands, nextIndex, resolvedTree: after.resolvedTree, compilation };
    updateExactDraftReconciliation({
      expected: latest,
      operation: `recording ${step.command} validation progress`,
      transition: () => ({ ...latest, validationRun: nextRun }),
    });
    return {
      command: step.command,
      exitCode: 0,
      nextCommand: run.steps[nextIndex]?.command,
      passedCommands: commands.length,
      remainingCommands: run.steps.length - nextIndex,
      status: "in_progress" as const,
    };
  }
  updateExactDraftReconciliation({
    expected: latest,
    operation: "recording validated merge content",
    transition: () => {
      const next = {
        ...latest,
        validation: {
          commands,
          resolvedTree: after.resolvedTree,
          validatedByCallId: ctx.callId,
          compilation,
        },
      };
      delete next.validationRun;
      return next;
    },
  });
  return {
    command: step.command,
    commands,
    resolvedTree: after.resolvedTree,
    status: "validated" as const,
  };
};

export default defineTool({
  description:
    "Compile the selected app once for this coherent candidate validation, then run repository app:check and all declared app:test shards without repeating their compile dependency, optional local/browser and check: tasks, and capture its actual checked release. Reuse installed dependencies; only concrete missing-dependency diagnostics schedule locked installation. Failures identify the command and cause. This does not update GitHub.",
  // oxlint-disable-next-line eslint/complexity -- ordered candidate checks need one exit for each named failure.
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    if (
      candidate === null ||
      state.phase !== "reviewed" ||
      currentDraftCandidateSource(state, candidate) === undefined ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "The prepared merge candidate no longer matches the selected app and source review. Prepare reconciliation again.",
      );
    }
    const sandbox = withCandidateCommandEnvironment(await getSourceBoundSandbox(ctx));
    if (candidate.validationRun?.schemaTaskCompleted !== true) {
      await retireUnusedDraftWorktrees({
        sandbox,
        workspaceRoot: candidate.workspaceRoot,
        retainedRoots: [
          state.workspace.workspacePath,
          state.applyReceipt.applyRoot,
          ...state.validationReceipt.commands.map((command) => command.validationRoot),
          candidate.root,
          ...(candidate.preservedWorkspaces ?? []).map((workspace) => workspace.root),
          ...draftReconciliationCompletions.get().map((completion) => completion.root),
        ],
        signal: ctx.abortSignal,
      });
    }
    await attachCheckoutDependencyView({
      sandbox,
      checkoutRoot: `${candidate.workspaceRoot}/repository`,
      candidateRoot: candidate.root,
      workspaceRoot: candidate.workspaceRoot,
    });
    let current = candidate;
    let expectedCommand = input.expectedCommand;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Single-call mode uses the same durable ordered steps as incremental mode.
      const result = await runIncrementalValidation(
        { ...input, expectedCommand },
        ctx,
        current,
        sandbox,
      );
      if (input.incremental || result.status !== "in_progress") {
        return result;
      }
      const latest = draftReconciliationState.get();
      if (latest === null) {
        throw new Error("The candidate is unavailable after its validation command.");
      }
      current = latest;
      expectedCommand = result.nextCommand;
    }
  },
  inputSchema: z.strictObject({
    additionalCheckTasks: z.array(z.string().regex(/^check:[A-Za-z0-9:_-]+$/u)).default([]),
    expectedCommand: z.string().max(1024).optional(),
    incremental: z.boolean().default(false),
    runBrowserTests: z.boolean().default(false),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
