import { workingPreviewState } from "@/lib/agent/working-preview-state";
import { hasCurrentProductBehaviorPreview } from "@/lib/agent/product-behavior-state";
import {
  PrivatePreviewBrowserPrerequisiteError,
  withPrivatePreviewBrowserAccess,
} from "@/lib/agent/private-preview-browser-access";
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

import {
  appBrowserTestCommand,
  runAppBrowserTests as runResolvedAppBrowserTests,
} from "../../lib/agent/app-browser-test-runner";

export { appBrowserTestCommand } from "../../lib/agent/app-browser-test-runner";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const runAppBrowserTests = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run"> & Partial<Pick<SandboxSession, "writeTextFile">>;
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
  const runtime =
    input.runtime ?? (execution ? await resolvePreparedRuntimeExecution(execution) : null);
  const run = (environment?: Record<string, string>) =>
    runResolvedAppBrowserTests({
      ...runInput,
      runtime,
      ...(environment ? { privateBrowserEnvironment: environment } : {}),
    });
  if (runtime || !execution) {
    return await run();
  }
  const preview = workingPreviewState.get();
  if (!preview) {
    return await run();
  }
  const identity = (value: typeof preview) =>
    JSON.stringify([
      value.commandId,
      value.providerSessionId,
      value.sandboxId,
      value.receipt.appId,
      value.receipt.url,
      value.receipt.expiresAt,
      value.requestDigest,
    ]);
  const frozenIdentity = identity(preview);
  try {
    const assertCurrent = () => {
      const current = workingPreviewState.get();
      if (
        !current ||
        identity(current) !== frozenIdentity ||
        !hasCurrentProductBehaviorPreview(preview.commandId)
      ) {
        throw new PrivatePreviewBrowserPrerequisiteError();
      }
    };
    return await withPrivatePreviewBrowserAccess({
      appId: input.appId,
      root: input.root,
      sandboxId: execution.sandboxId,
      preview,
      sandbox: input.sandbox,
      signal: input.signal,
      assertCurrent,
      operation: run,
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    if (!(error instanceof PrivatePreviewBrowserPrerequisiteError)) {
      throw error;
    }
    return {
      status: "failed" as const,
      reason: error.code,
      problem: error.message,
      command: appBrowserTestCommand(input.appId),
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }
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
