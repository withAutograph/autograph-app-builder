import { readOptionalLocalBrowserAuthOrigin } from "@/lib/repository/local-preview-auth-origin";
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
import { priorValidatedPrivateArtifact } from "@/lib/agent/prior-validated-private-artifact";
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

// oxlint-disable-next-line eslint/complexity -- Keep explicit prior-preview selection separate from existing hosted and local paths.
export const runAppBrowserTests = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run"> & Partial<Pick<SandboxSession, "writeTextFile">>;
  signal?: AbortSignal;
  execution?: PreparedRuntimeExecutionContext;
  selection?: BrowserTestSelection;
  runtime?: PreparedRuntimeExecution | null;
  priorArtifact?: Awaited<ReturnType<typeof priorValidatedPrivateArtifact>>;
  continuation?: {
    commandId?: string;
    commandCheckpoint: (commandId: string) => Promise<void>;
    allowDispatch: boolean;
  };
}) => {
  const { execution, priorArtifact, ...runInput } = input;
  let runtime: PreparedRuntimeExecution | null;
  try {
    runtime = null;
    if (priorArtifact === undefined) {
      runtime =
        input.runtime ?? (execution ? await resolvePreparedRuntimeExecution(execution) : null);
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    // Keep resolution failures inside the shared runner's bounded diagnostics;
    // a refused binding must never fall back to an unbound browser command.
    return await runResolvedAppBrowserTests({
      ...runInput,
      resolveRuntime: () => {
        throw error;
      },
    });
  }
  const run = async (environment?: Record<string, string>, assertPreview?: () => void) => {
    await priorArtifact?.verifyCurrent();
    assertPreview?.();
    const browserInput: Parameters<typeof runResolvedAppBrowserTests>[0] = {
      ...runInput,
      runtime,
    };
    if (environment) {
      browserInput.privateBrowserEnvironment = environment;
    }
    return await runResolvedAppBrowserTests(browserInput);
  };
  if (priorArtifact !== undefined && execution === undefined) {
    throw new Error("The prior validated artifact requires an owned private preview.");
  }
  if (runtime || !execution) {
    return await run();
  }
  const preview = workingPreviewState.get();
  const identity = (value: NonNullable<typeof preview>) =>
    JSON.stringify([
      value.commandId,
      value.providerSessionId,
      value.sandboxId,
      value.receipt.appId,
      value.receipt.url,
      value.receipt.expiresAt,
      value.requestDigest,
      value.priorValidatedArtifact,
    ]);
  try {
    if (
      priorArtifact !== undefined &&
      (preview?.priorValidatedArtifact?.applyDigest !== priorArtifact.revision ||
        preview.priorValidatedArtifact.validationDigest !== priorArtifact.validationDigest)
    ) {
      throw new PrivatePreviewBrowserPrerequisiteError();
    }
    if (!preview) {
      let origin;
      try {
        origin = await readOptionalLocalBrowserAuthOrigin(input);
      } catch {
        input.signal?.throwIfAborted();
        throw new PrivatePreviewBrowserPrerequisiteError();
      }
      if (origin !== null && origin !== "http://localhost:3000") {
        throw new PrivatePreviewBrowserPrerequisiteError();
      }
      return await run();
    }
    const frozenIdentity = identity(preview);
    const assertCurrent = () => {
      priorArtifact?.assertCurrent();
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
      operation: async (environment) => await run(environment, assertCurrent),
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
    "Run the selected app's repository-owned test-e2e mise task, recovering its prepared Preview workspace through Builder when the original apply checkout is stale or missing. Optional selection passes a literal Playwright test-title filter and execution controls as structured arguments; omitted selection retains the app task's default behavior. Use this when the app defines that task and the accepted behavior requires browser interaction that the JSON behavior verifier cannot exercise. Protected normal actor sessions, when supplied by the runtime binding, are restored privately at their verified browser origin. Prepare sandbox-local data first only for local app tasks that require it. Use artifact=prior-validated to test the exact last validated local artifact while a newer plan remains unapplied. This runs real browser tests and returns the exact command, exit status, and bounded redacted output; it does not publish or deploy. Passing tests are evidence for the scenarios asserted by those tests, not proof of every product outcome.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    const priorArtifact =
      input.artifact === "prior-validated"
        ? await priorValidatedPrivateArtifact({
            appId: input.appId,
            sandbox,
            state,
            sessionId: ctx.session.id,
            signal: ctx.abortSignal,
          })
        : undefined;
    const selected =
      priorArtifact ??
      (await runnableSelectedApp({
        appId: input.appId,
        state,
        resolveRoot: async ({ appId, root }) =>
          await resolveAcceptanceRuntimeRoot({ appId, fallbackRoot: root, sandbox, state, ctx }),
      }));
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
      priorArtifact,
    });
  },
  inputSchema: z.strictObject({
    artifact: z.literal("prior-validated").optional(),
    appId: appIdSchema.optional(),
    selection: browserTestSelectionSchema.optional(),
  }),
});
