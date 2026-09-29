import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { resolveHostedRuntimeDeployment } from "@/lib/provisioning/hosted-runtime-deployment";
import { cleanupHostedRuntime } from "@/lib/provisioning/hosted-runtime-cleanup";
import { withHostedInstallerSandbox } from "@/lib/provisioning/hosted-runtime-installer";
import { HostedRuntimeProviderError } from "@/lib/provisioning/hosted-runtime-provider";
import { createHostedRuntimeSandboxExecutor } from "@/lib/provisioning/hosted-runtime-sandbox";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "@/lib/sandbox/vercel-preview-provider";

export default defineTool({
  approval: always(),
  description:
    "After separate approval for the named app, selected Vercel project and exact Preview branch, remove only this session's owned runtime environment bindings and isolated app/authentication databases and roles. Verify ownership before destructive statements, checkpoint unfinished cleanup, and retry the same journal if interrupted. Active deployments may lose access to these approved disposable Preview resources. This does not deploy, promote, alias, activate, or change Production or integration-owned variables. An inactive owner connection requires reauthorization before cleanup.",
  async execute(input, ctx) {
    try {
      const sandbox = await ctx.getSandbox();
      const selected = await runnableSelectedApp({
        appId: input.appId,
        sandbox,
        state: appBuilderWorkflowState.get(),
      });
      const runtime = await resolveHostedRuntimeDeployment({
        appId: input.appId,
        branch: input.branch,
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      if (runtime.target.projectId !== input.projectId) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
      const provider = await getVercelPreviewProvider(sandbox.id, ctx.abortSignal);
      return await withHostedInstallerSandbox({
        root: selected.root,
        run: async (control, signal) =>
          await cleanupHostedRuntime({
            ...runtime,
            approvedByCallId: ctx.callId,
            executor: createHostedRuntimeSandboxExecutor({
              appId: input.appId,
              provider: control,
              root: selected.root,
              signal,
              stateDirectory: runtime.stateDirectory,
            }),
            signal,
          }),
        signal: ctx.abortSignal,
        source: provider,
      });
    } catch (error) {
      return {
        appId: input.appId,
        code:
          error instanceof HostedRuntimeProviderError ? error.code : "runtime_cleanup_unavailable",
        status: "blocked" as const,
      };
    }
  },
  inputSchema: z.strictObject({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    branch: z
      .string()
      .min(1)
      .refine((value) => !/[\p{Cc}]/u.test(value)),
    environment: z.literal("preview"),
    projectId: z.string().min(1),
  }),
});
