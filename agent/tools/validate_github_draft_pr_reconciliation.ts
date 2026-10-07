import { defineTool } from "eve/tools";
import { publishCompiledOperatorArtifactsForSession } from "@/lib/agent/compiled-operator-artifacts";
import type { ToolContext } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appSchemaReleaseCommand, compileAppSchemaRelease } from "./compile-app-schema-release";
import {
  appDeclaresLocalSetup,
  localPreviewExecutionCommand,
  prepareAppLocalPreview,
  prepareValidationLocalData,
} from "./prepare-app-local-preview";
import { appBrowserTestCommand, runAppBrowserTests } from "./run-app-browser-tests";
import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import type { DraftReconciliationCandidate } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { supportedValidationCommands } from "@/lib/repository/supported-template";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import {
  sandboxValidationCommandExecutor,
  validationOutputExcerpt,
} from "@/lib/repository/target-validation";

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
    appId: candidate.appId,
    appSpecDigest: state.appSpec.digest,
    callId: ctx.callId,
    root: candidate.root,
    sandbox,
    sessionAuth: ctx.session.auth,
    signal: ctx.abortSignal,
  });
};

const runAdditionalChecks = async (input: {
  sandbox: SandboxSession;
  root: string;
  tasks: readonly string[];
}) => {
  const commands: { command: string; exitCode: number }[] = [];
  for (const task of input.tasks) {
    const command = `mise run --skip-tools ${task}`;
    let result: Awaited<ReturnType<SandboxSession["run"]>>;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- repository checks must run sequentially against the same candidate.
      result = await input.sandbox.run({ command, workingDirectory: input.root });
    } catch (error) {
      throw new Error(
        `Builder could not run ${command} in the reconciled checkout. Check the sandbox command runner and the repository task, then retry. Cause: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    commands.push({ command, exitCode: result.exitCode });
    if (result.exitCode !== 0) {
      return {
        commands,
        failure: {
          command,
          exitCode: result.exitCode,
          output: validationOutputExcerpt(result.stdout, result.stderr),
          problem: `The reconciled checkout failed ${command}. Repair the reported repository configuration or check, then rerun candidate validation before review.`,
          status: "needs_repair" as const,
        },
      };
    }
  }
  return { commands };
};

type ValidationStep = NonNullable<DraftReconciliationCandidate["validationRun"]>["steps"][number];
interface ValidationStepResult {
  command: string;
  exitCode: number | null;
  status: "passed" | "failed";
  problem?: string;
  output?: ReturnType<typeof validationOutputExcerpt>;
}

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
  let run = candidate.validationRun ?? null;
  const checkoutChanged = run !== null && run.resolvedTree !== before.resolvedTree;
  if (checkoutChanged) {
    // An expired/replaced sandbox or a normal source edit invalidates only this validation pass.
    run = null;
  }
  if (run === null) {
    const local = await appDeclaresLocalSetup({
      appId: candidate.appId,
      root: candidate.root,
      sandbox,
    });
    const steps: ValidationStep[] = [
      { command: "mise exec -- bun install --frozen-lockfile", kind: "install" },
      { command: appSchemaReleaseCommand(candidate.appId), kind: "schema" },
      ...(local
        ? [{ command: localPreviewExecutionCommand(candidate.appId), kind: "local" as const }]
        : []),
      ...supportedValidationCommands(candidate.appId).map(({ command }) => ({
        command,
        kind: "check" as const,
      })),
      ...(input.runBrowserTests
        ? [{ command: appBrowserTestCommand(candidate.appId), kind: "browser" as const }]
        : []),
      ...input.additionalCheckTasks.map((task) => ({
        command: `mise run --skip-tools ${task}`,
        kind: "additional" as const,
      })),
    ];
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
        delete next.reviewReadProgress;
        return next;
      },
    });
  }
  const step = run.steps[run.nextIndex];
  if (step === undefined) {
    throw new Error(
      "Candidate validation has no next command. Inspect this saved session and restart validation.",
    );
  }
  if (input.expectedCommand !== undefined && input.expectedCommand !== step.command) {
    throw new Error(
      `Candidate validation is ready for ${step.command}, but this call supplied a different command.${checkoutChanged ? " The checkout changed since the prior validation command, so Builder restarted the check sequence." : ""} Resume with the returned nextCommand; no command was run.`,
    );
  }
  let result: ValidationStepResult;
  try {
    if (step.kind === "schema") {
      const schema = await compileAppSchemaRelease({
        appId: candidate.appId,
        onCompiled: async () => {
          await publishCandidateArtifacts(ctx, candidate, sandbox);
        },
        root: candidate.root,
        sandbox,
        signal: ctx.abortSignal,
      });
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
      const planned = supportedValidationCommands(candidate.appId).find(
        ({ command }) => command === step.command,
      );
      if (step.kind === "check" && planned === undefined) {
        throw new Error(`The selected repository check ${step.command} is no longer supported.`);
      }
      const execution =
        step.kind === "check" && planned !== undefined
          ? await sandboxValidationCommandExecutor()({
              appId: candidate.appId,
              command: planned.command,
              sandbox,
              validationRoot: candidate.root,
            })
          : await sandbox.run({
              abortSignal: ctx.abortSignal,
              command: step.command,
              workingDirectory: candidate.root,
            });
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
  const commands = [...run.commands, { command: step.command, exitCode: 0 }];
  const latest = draftReconciliationState.get();
  const nextIndex = run.nextIndex + 1;
  if (nextIndex < run.steps.length) {
    const nextRun = { ...run, commands, nextIndex, resolvedTree: after.resolvedTree };
    updateExactDraftReconciliation({
      expected: latest,
      operation: `recording ${step.command} validation progress`,
      transition: () => ({ ...candidate, validationRun: nextRun }),
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
        ...candidate,
        validation: { commands, resolvedTree: after.resolvedTree, validatedByCallId: ctx.callId },
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
    "Install the candidate's own locked dependencies, compile its selected app schema, run repository app:check and app:test, and optionally run the app's browser task and repository check: tasks. All commands run in the isolated reconciled checkout; failures identify the command and cause. This does not update GitHub.",
  // oxlint-disable-next-line eslint/complexity -- ordered candidate checks need one exit for each named failure.
  async execute(input, ctx) {
    const candidate = draftReconciliationState.get();
    const state = appBuilderWorkflowState.get();
    if (
      candidate === null ||
      state.phase !== "reviewed" ||
      state.githubSource?.digest !== candidate.githubSourceDigest ||
      state.reviewReceipt.digest !== candidate.originalReviewDigest
    ) {
      throw new Error(
        "The prepared merge candidate no longer matches the selected app and source review. Prepare reconciliation again.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    if (input.incremental) {
      return await runIncrementalValidation(input, ctx, candidate, sandbox);
    }
    const before = await inspectDraftReconciliation({ prepared: candidate, sandbox });
    if (before.unresolvedConflicts.length > 0) {
      return {
        conflicts: before.unresolvedConflicts,
        problem: "Resolve every listed app-owned conflict before running candidate checks.",
        status: "needs_resolution" as const,
      };
    }
    updateExactDraftReconciliation({
      expected: candidate,
      operation: "starting candidate validation",
      transition: () => {
        const next = { ...candidate };
        delete next.proposal;
        delete next.review;
        delete next.reviewReadProgress;
        delete next.validation;
        delete next.validationRun;
        return next;
      },
    });
    const commands: { command: string; exitCode: number }[] = [];
    const installCommand = "mise exec -- bun install --frozen-lockfile";
    let install: Awaited<ReturnType<typeof sandbox.run>>;
    try {
      install = await sandbox.run({ command: installCommand, workingDirectory: candidate.root });
    } catch (error) {
      throw new Error(
        `Builder could not install dependencies in the reconciled checkout with ${installCommand}. Check sandbox package access and the repository lockfile, then retry. Cause: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    commands.push({ command: installCommand, exitCode: install.exitCode });
    if (install.exitCode !== 0) {
      return {
        command: installCommand,
        exitCode: install.exitCode,
        output: validationOutputExcerpt(install.stdout, install.stderr),
        problem:
          "The reconciled checkout's locked dependency install failed. Fix the reported package or lockfile issue, then rerun candidate validation.",
        status: "needs_repair" as const,
      };
    }
    const schema = await compileAppSchemaRelease({
      appId: candidate.appId,
      onCompiled: async () => {
        await publishCandidateArtifacts(ctx, candidate, sandbox);
      },
      root: candidate.root,
      sandbox,
      signal: ctx.abortSignal,
    });
    commands.push({ command: schema.command, exitCode: schema.exitCode ?? -1 });
    if (schema.status !== "compiled") {
      return { ...schema, status: "needs_repair" as const };
    }
    await prepareValidationLocalData({
      appId: candidate.appId,
      root: candidate.root,
      sandbox,
      signal: ctx.abortSignal,
    });
    const execute = sandboxValidationCommandExecutor();
    for (const planned of supportedValidationCommands(candidate.appId)) {
      let result: Awaited<ReturnType<typeof execute>>;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- checks must run against the same candidate in repository order.
        result = await execute({
          appId: candidate.appId,
          command: planned.command,
          sandbox,
          validationRoot: candidate.root,
        });
      } catch (error) {
        throw new Error(
          `Builder could not run ${planned.command} in the reconciled checkout. Check the sandbox command runner and repository task, then retry. Cause: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      commands.push({ command: planned.command, exitCode: result.exitCode });
      if (result.exitCode !== 0) {
        return {
          command: planned.command,
          exitCode: result.exitCode,
          output: validationOutputExcerpt(result.stdout, result.stderr),
          problem: `The reconciled app failed ${planned.command}. Repair the named file or test assertion, then rerun validation before review.`,
          status: "needs_repair" as const,
        };
      }
    }
    if (input.runBrowserTests) {
      const browser = await runAppBrowserTests({
        appId: candidate.appId,
        root: candidate.root,
        sandbox,
        signal: ctx.abortSignal,
      });
      commands.push({ command: browser.command, exitCode: browser.exitCode ?? -1 });
      if (browser.status !== "passed") {
        return { ...browser, status: "needs_repair" as const };
      }
    }
    const additional = await runAdditionalChecks({
      root: candidate.root,
      sandbox,
      tasks: input.additionalCheckTasks,
    });
    commands.push(...additional.commands);
    if (additional.failure !== undefined) {
      return additional.failure;
    }
    const after = await inspectDraftReconciliation({ prepared: candidate, sandbox });
    if (after.unresolvedConflicts.length > 0) {
      return {
        conflicts: after.unresolvedConflicts,
        problem:
          "Repository checks left unresolved conflicts. Resolve them and rerun candidate validation.",
        status: "needs_resolution" as const,
      };
    }
    const latest = draftReconciliationState.get();
    updateExactDraftReconciliation({
      expected: latest,
      operation: "recording validated merge content",
      transition: () => ({
        ...candidate,
        validation: {
          commands,
          resolvedTree: after.resolvedTree,
          validatedByCallId: ctx.callId,
        },
      }),
    });
    return {
      commands,
      resolvedTree: after.resolvedTree,
      status: "validated" as const,
    };
  },
  inputSchema: z.strictObject({
    additionalCheckTasks: z.array(z.string().regex(/^check:[A-Za-z0-9:_-]+$/u)).default([]),
    expectedCommand: z.string().max(1024).optional(),
    incremental: z.boolean().default(false),
    runBrowserTests: z.boolean().default(false),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
