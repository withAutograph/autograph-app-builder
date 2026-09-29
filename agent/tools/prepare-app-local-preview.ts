import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { describeSelectedApp } from "@/lib/repository/app-description";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";

export { localRuntimeEnvironmentPath } from "@/lib/repository/runtime-environment";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const localPreviewSetupCommand = (appId: string): string =>
  `MISE_TASK_RUN_AUTO_INSTALL=true MISE_AUTO_INSTALL=true mise run app:runtime prepare ${appIdSchema.parse(appId)} local`;

export const appDeclaresLocalSetup = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
}): Promise<boolean> => {
  const description = await describeSelectedApp(input);
  return description.backend.kind === "generated-postgres";
};

export const localPreviewExecutionCommand = localPreviewSetupCommand;

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
  authOrigin?: string;
}) => {
  const origin =
    input.authOrigin === undefined
      ? undefined
      : z
          .string()
          .regex(/^https:\/\/[a-z0-9-]+\.vercel\.run$/u)
          .parse(input.authOrigin);
  const prefix = origin === undefined ? "" : `APP_RUNTIME_AUTH_ORIGIN='${origin}' `;
  const command = prefix + localPreviewExecutionCommand(input.appId);
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
        problem: `The selected app's repository-owned local setup exited with status ${result.exitCode}. Inspect the output for a repository-pinned tool installation failure, local database startup failure, or schema error. Repair that cause in the private sandbox and retry setup before opening the app preview.`,
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

/** Start declared local data before validation so test runners do not own the server's output pipe. */
export const prepareValidationLocalData = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}): Promise<void> => {
  if (!(await appDeclaresLocalSetup(input))) {
    return;
  }
  const setup = await prepareAppLocalPreview(input);
  if (setup.status === "failed") {
    throw new Error(
      `Validation could not prepare the selected app's local data. ${setup.problem}\nCommand: ${setup.command}\n${setup.stderr || setup.stdout || "No command output was returned."}`,
    );
  }
};

export default defineTool({
  description:
    "Prepare the selected app's isolated authenticated PostgreSQL runtime, real Auth identities and app memberships using repository-owned app:describe and app:runtime commands. This installs no product demo seeds. Application behavior remains unassessed until its authenticated tests run. Do not use this local operation for hosted or Production resources.",
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
