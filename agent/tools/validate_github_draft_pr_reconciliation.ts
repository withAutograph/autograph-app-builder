import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { compileAppSchemaRelease } from "./compile-app-schema-release";
import { prepareValidationLocalData } from "./prepare-app-local-preview";
import { runAppBrowserTests } from "./run-app-browser-tests";
import {
  draftReconciliationState,
  updateExactDraftReconciliation,
} from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { supportedValidationCommands } from "@/lib/repository/supported-template";
import { inspectDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import {
  sandboxValidationCommandExecutor,
  validationOutputExcerpt,
} from "@/lib/repository/target-validation";

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
    runBrowserTests: z.boolean().default(false),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
