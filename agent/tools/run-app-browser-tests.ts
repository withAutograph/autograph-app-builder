import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const appBrowserTestCommand = (appId: string): string =>
  `mise run --skip-tools //apps/${appIdSchema.parse(appId)}:test-e2e`;

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
}) => {
  const command = appBrowserTestCommand(input.appId);
  try {
    const result =
      input.signal === undefined
        ? await input.sandbox.run({ command, workingDirectory: input.root })
        : await input.sandbox.run({
            abortSignal: input.signal,
            command,
            workingDirectory: input.root,
          });
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
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "applied" &&
      state.phase !== "validation_failed" &&
      state.phase !== "validated" &&
      state.phase !== "reviewed"
    ) {
      throw new Error("Apply the selected app before running its browser tests.");
    }
    return await runAppBrowserTests({
      appId: state.appSpec.appId,
      root: state.applyReceipt.applyRoot,
      sandbox: await ctx.getSandbox(),
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({}),
});
