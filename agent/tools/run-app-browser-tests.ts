import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { resolveAcceptanceRuntimeRoot } from "@/lib/agent/acceptance-runtime-root";
import { browserTestSelectionSchema } from "@/lib/agent/browser-test-selection";
import type { BrowserTestSelection } from "@/lib/agent/browser-test-selection";
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
  selection?: BrowserTestSelection;
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
    "Run the selected app's repository-owned test-e2e mise task, recovering its prepared Preview workspace through Builder when the original apply checkout is stale or missing. Optional selection passes a literal Playwright test-title filter and execution controls as structured arguments; omitted selection retains the app task's default behavior. Use this when the app defines that task and the accepted behavior requires browser interaction that the JSON behavior verifier cannot exercise. Protected normal actor sessions, when supplied by the runtime binding, are restored privately at their verified browser origin. Prepare sandbox-local data first only for local app tasks that require it. This runs real browser tests and returns the exact command, exit status, and bounded redacted output; it does not publish or deploy. Passing tests are evidence for the scenarios asserted by those tests, not proof of every product outcome.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    const selected = await runnableSelectedApp({
      appId: input.appId,
      sandbox,
      state,
      resolveRoot: async ({ appId, root }) =>
        await resolveAcceptanceRuntimeRoot({ appId, fallbackRoot: root, sandbox, state, ctx }),
    });
    const root = selected.root;
    return await runAppBrowserTests({
      appId: selected.appId,
      execution: {
        appId: selected.appId,
        root,
        sandboxId: getBuilderSandboxId(sandbox),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
        signal: ctx.abortSignal,
        state,
      },
      root,
      sandbox,
      signal: ctx.abortSignal,
      selection: input.selection,
    });
  },
  inputSchema: z.strictObject({
    appId: appIdSchema.optional(),
    selection: browserTestSelectionSchema.optional(),
  }),
});
