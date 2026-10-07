import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { publishCompiledOperatorArtifactsForSession } from "@/lib/agent/compiled-operator-artifacts";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const appSchemaReleaseCommand = (appId: string): string =>
  `mise run app:compile ${appIdSchema.parse(appId)}`;

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
  onCompiled?: () => Promise<void>;
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
        problem: `The ${input.appId} schema release compiler exited with status ${result.exitCode}.${stdout || stderr ? " Read the compiler output and fix the named CUE source or missing tool, then run this operation again." : " The compiler returned no output; inspect the repository's app:compile task and compiler logs."}`,
        status: "failed" as const,
        stderr,
        stdout,
      };
    }
    if (input.onCompiled !== undefined) {
      try {
        await input.onCompiled();
      } catch {
        return {
          command,
          exitCode: 0,
          problem:
            "The schema compiled, but Builder could not capture its selected release under the current owner and session. Retry this operation after restoring private artifact storage and current session authority.",
          status: "failed" as const,
          stderr,
          stdout,
        };
      }
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
    "Regenerate the selected app's checked CUE schema release in its already approved private checkout, including after an initial validation pass. The fixed repository-owned `app:compile` task targets only the selected app. The workflow privately captures the compiled app release for its protected operator; this does not deploy or publish source externally. The result includes the exact command, exit status, and sanitized compiler output; rerun validate_app_creation after compilation.",
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "applied" &&
      state.phase !== "validation_failed" &&
      state.phase !== "validated"
    ) {
      throw new Error(
        "Compile the selected app schema only after the private app build is applied and before change review; rerun app validation afterward.",
      );
    }
    const sandbox = await ctx.getSandbox();
    if (state.phase !== "applied") {
      updateExactWorkflow({
        expected: state,
        operation: "schema release invalidates prior validation",
        transition: () => ({
          appSpec: state.appSpec,
          applyReceipt: state.applyReceipt,
          artifacts: state.artifacts,
          dependencyReceipt: state.dependencyReceipt,
          githubSource: state.githubSource,
          identityReceipt: state.identityReceipt,
          phase: "applied",
          preparedByCallId: state.preparedByCallId,
          proposal: state.proposal,
          publishedGitHubDraftProposalDigest: state.publishedGitHubDraftProposalDigest,
          sourceReceipt: state.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: state.workspace,
        }),
      });
    }
    return await compileAppSchemaRelease({
      appId: state.appSpec.appId,
      onCompiled: async () => {
        await publishCompiledOperatorArtifactsForSession({
          adapterSessionId: ctx.session.id,
          appId: state.appSpec.appId,
          appSpecDigest: state.appSpec.digest,
          callId: ctx.callId,
          root: state.applyReceipt.applyRoot,
          sandbox,
          sessionAuth: ctx.session.auth,
          signal: ctx.abortSignal,
        });
      },
      root: state.applyReceipt.applyRoot,
      sandbox,
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({}),
});
