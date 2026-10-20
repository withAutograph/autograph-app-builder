import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
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

import { runAppBrowserTests as runResolvedAppBrowserTests } from "../../lib/agent/app-browser-test-runner";

export { appBrowserTestCommand } from "../../lib/agent/app-browser-test-runner";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const runAppBrowserTests = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
  execution?: PreparedRuntimeExecutionContext;
  runtime?: PreparedRuntimeExecution | null;
  continuation?: {
    commandId?: string;
    commandCheckpoint: (commandId: string) => Promise<void>;
    allowDispatch: boolean;
  };
}) => {
  const { execution, ...runInput } = input;
  return await runResolvedAppBrowserTests({
    ...runInput,
    resolveRuntime: execution ? () => resolvePreparedRuntimeExecution(execution) : undefined,
  });
};

export default defineTool({
  description:
    "Run the selected app's repository-owned test-e2e mise task in its approved private checkout. Use this when the app defines that task and the accepted behavior requires browser interaction that the JSON behavior verifier cannot exercise. Protected normal actor sessions, when supplied by the runtime binding, are restored privately at their verified browser origin. Prepare sandbox-local data first only for local app tasks that require it. This runs real browser tests and returns the exact command, exit status, and bounded redacted output; it does not publish or deploy. Passing tests are evidence for the scenarios asserted by those tests, not proof of every product outcome.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    const selected = await runnableSelectedApp({ appId: input.appId, sandbox, state });
    return await runAppBrowserTests({
      appId: selected.appId,
      execution: {
        appId: selected.appId,
        root: selected.root,
        sandboxId: getBuilderSandboxId(sandbox),
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
