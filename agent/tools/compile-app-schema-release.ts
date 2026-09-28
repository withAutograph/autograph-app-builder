import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const appSchemaReleaseCommand = (appId: string): string =>
  `mise run --skip-tools schema:release -- compile --app ${appIdSchema.parse(appId)}`;

const safeOutput = (value: string): string => {
  const cleaned = value
    .replaceAll(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .trim();
  return cleaned;
};

export const compileAppSchemaRelease = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}) => {
  const command = appSchemaReleaseCommand(input.appId);
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
        problem: `The ${input.appId} schema release compiler exited with status ${result.exitCode}.${stdout || stderr ? " Read the compiler output and fix the named CUE source or missing tool, then run this operation again." : " The compiler returned no output; inspect the repository's schema:release task and compiler logs."}`,
        status: "failed" as const,
        stderr,
        stdout,
      };
    }
    return { command, exitCode: 0, status: "compiled" as const, stderr, stdout };
  } catch (error) {
    const detail = safeOutput(error instanceof Error ? error.message : String(error));
    return {
      command,
      exitCode: null,
      problem: `The execution provider could not run the ${input.appId} schema release compiler in ${input.root}. Cause: ${detail || "No provider error detail was returned."} Check the private sandbox and repository working directory, then retry.`,
      status: "failed" as const,
      stderr: "",
      stdout: "",
    };
  }
};

export default defineTool({
  description:
    "Regenerate the selected existing app's checked CUE schema release in its already approved private checkout when validation reports stale schema artifacts. The fixed repository-owned `schema:release -- compile --app` task targets only the selected app. This does not publish or deploy. The result includes the exact command, exit status, and sanitized compiler output; rerun validate_app_creation after compilation.",
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "applied" && state.phase !== "validation_failed") {
      throw new Error(
        "Compile the selected app schema only after the private app build is applied and before change review; rerun app validation afterward.",
      );
    }
    return await compileAppSchemaRelease({
      appId: state.appSpec.appId,
      root: state.applyReceipt.applyRoot,
      sandbox: await ctx.getSandbox(),
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({}),
});
