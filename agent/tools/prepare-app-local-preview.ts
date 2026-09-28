import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const localPreviewSetupCommand = (appId: string): string =>
  `mise run --skip-tools app:local -- ${appIdSchema.parse(appId)} setup`;

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
    .slice(-6000)
    .trim();

export const prepareAppLocalPreview = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}) => {
  const command = localPreviewSetupCommand(input.appId);
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
        problem: `The selected app's repository-owned local setup exited with status ${result.exitCode}. Inspect the output for a missing local PostgreSQL executable, database startup failure, or schema error. Repair that cause in the private sandbox and retry setup before opening the app preview.`,
        status: "failed" as const,
        stderr,
        stdout,
      };
    }
    return { command, exitCode: 0, status: "prepared" as const, stderr, stdout };
  } catch (error) {
    const detail = safeOutput(error instanceof Error ? error.message : String(error));
    return {
      command,
      exitCode: null,
      problem: `The private sandbox could not run repository-owned local setup for ${input.appId}. Cause: ${detail || "No provider detail was returned."} Check the sandbox command runner and repository task, then retry.`,
      status: "failed" as const,
      stderr: "",
      stdout: "",
    };
  }
};

export default defineTool({
  description:
    "Prepare the selected app's sandbox-local preview data through its repository-owned app:local setup task. Use only when that task exists and the app needs local data before browser verification. It runs in the approved private checkout, does not use a hosted database or publish source, and reports the exact command and bounded diagnostic output. Do not use this for Production resources.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    const selected = await runnableSelectedApp({ appId: input.appId, sandbox, state });
    return await prepareAppLocalPreview({
      appId: selected.appId,
      root: selected.root,
      sandbox,
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({ appId: appIdSchema.optional() }),
});
