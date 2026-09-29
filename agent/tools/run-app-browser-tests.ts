import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { resolvePreparedRuntimeExecution } from "@/lib/agent/prepared-runtime-execution";
import type {
  PreparedRuntimeExecution,
  PreparedRuntimeExecutionContext,
} from "@/lib/agent/prepared-runtime-execution";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const appBrowserTestCommand = (appId: string): string =>
  `mise run app:runtime run ${appIdSchema.parse(appId)} test-e2e`;

const safeOutput = (value: string): string =>
  value
    .replaceAll(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .replaceAll(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "[CREDENTIAL REDACTED]",
    )
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .slice(-8000)
    .trim();

export const runAppBrowserTests = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
  execution?: PreparedRuntimeExecutionContext;
  runtime?: PreparedRuntimeExecution | null;
}) => {
  const command = appBrowserTestCommand(input.appId);
  try {
    const runtime =
      input.runtime ??
      (input.execution ? await resolvePreparedRuntimeExecution(input.execution) : null);
    const runTask = async () => {
      if (runtime) {
        return await runtime.runTask({ signal: input.signal, task: "test-e2e" });
      }
      return input.signal === undefined
        ? await input.sandbox.run({ command, workingDirectory: input.root })
        : await input.sandbox.run({
            abortSignal: input.signal,
            command,
            workingDirectory: input.root,
          });
    };
    let result = await runTask();
    if (
      result.exitCode !== 0 &&
      /error while loading shared libraries: [A-Za-z0-9_.+-]+\.so/iu.test(
        `${result.stderr}\n${result.stdout}`,
      )
    ) {
      const dependencyCommand =
        'sudo env PATH="$PATH" ./node_modules/.bin/playwright install-deps chromium';
      const dependencies = await input.sandbox.run({
        command: dependencyCommand,
        workingDirectory: input.root,
      });
      if (dependencies.exitCode !== 0) {
        return {
          command: dependencyCommand,
          exitCode: dependencies.exitCode,
          problem:
            "Chromium could not start because a system library is missing, and Playwright could not install its Linux dependencies. Check package manager access in the private sandbox, then rerun the browser task.",
          status: "failed" as const,
          stderr: safeOutput(dependencies.stderr),
          stdout: safeOutput(dependencies.stdout),
        };
      }
      result = await runTask();
    }
    const stdout = safeOutput(result.stdout);
    const stderr = safeOutput(result.stderr);
    if (result.exitCode !== 0) {
      return {
        command,
        exitCode: result.exitCode,
        problem: `The selected app's browser test task exited with status ${result.exitCode}. Read the test name, assertion, server startup error, or missing browser/runtime dependency in the output. Fix that cause, then rerun this task in the private sandbox. A ready preview alone does not establish the requested behavior.`,
        status: "failed" as const,
        stderr,
        stdout,
      };
    }
    return {
      command,
      exitCode: 0,
      status: "passed" as const,
      stderr,
      stdout,
    };
  } catch (error) {
    const detail = safeOutput(error instanceof Error ? error.message : String(error));
    return {
      command,
      exitCode: null,
      problem: `The private sandbox could not run the selected app's repository-owned browser test task. Cause: ${detail || "No provider detail was returned."} Check the sandbox checkout, task discovery, and command runner, then retry.`,
      status: "failed" as const,
      stderr: "",
      stdout: "",
    };
  }
};

export default defineTool({
  description:
    "Run the selected app's repository-owned test-e2e mise task in its approved private checkout. Use this when the app defines that task and the accepted behavior requires browser interaction that the JSON behavior verifier cannot exercise. Prepare sandbox-local data first when the app requires it. This runs real browser tests and returns the exact command, exit status, and bounded redacted output; it does not publish or deploy. Passing tests are evidence for the scenarios asserted by those tests, not proof of every product outcome.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    const selected = await runnableSelectedApp({ appId: input.appId, sandbox, state });
    return await runAppBrowserTests({
      appId: selected.appId,
      execution: {
        appId: selected.appId,
        root: selected.root,
        sandboxId: sandbox.id,
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
        signal: ctx.abortSignal,
        state,
      },
      root: selected.root,
      sandbox,
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({ appId: appIdSchema.optional() }),
});
