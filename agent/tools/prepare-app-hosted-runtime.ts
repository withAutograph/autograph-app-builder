import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { resolveHostedRuntimeDeployment } from "@/lib/provisioning/hosted-runtime-deployment";
import { HostedRuntimeProviderError } from "@/lib/provisioning/hosted-runtime-provider";
import { createHostedRuntimeSandboxExecutor } from "@/lib/provisioning/hosted-runtime-sandbox";
import { prepareHostedRuntime } from "@/lib/provisioning/hosted-runtime-service";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "@/lib/sandbox/vercel-preview-provider";

export const hostedRuntimeApprovalInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: z
    .string()
    .min(1)
    .refine((value) => !/[\p{Cc}]/u.test(value)),
  environment: z.literal("preview"),
  port: z.number().int().min(1024).max(65_535).default(3000),
  projectId: z.string().min(1),
  roles: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).optional(),
});

export default defineTool({
  approval: always(),
  description:
    "After approval for the named app, Vercel project and exact Preview branch, prepare isolated app and authentication databases on that branch's existing native Neon connection and bind restricted runtime environment variables. Run the repository-owned app:runtime plan/prepare/verify tasks through Vercel Sandbox. Provide roles only from the accepted product design when its legacy schema has no declared policy roles. Credentials remain protected; missing native Neon connection is a product blocker. This operation does not deploy, promote, alias, activate, or modify Production.",
  async execute(input, ctx) {
    try {
      const state = appBuilderWorkflowState.get();
      const sandbox = await ctx.getSandbox();
      const selected = await runnableSelectedApp({ appId: input.appId, sandbox, state });
      const runtime = await resolveHostedRuntimeDeployment({
        appId: selected.appId,
        branch: input.branch,
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      if (runtime.target.projectId !== input.projectId) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
      const provider = await getVercelPreviewProvider(sandbox.id, ctx.abortSignal);
      return await prepareHostedRuntime({
        ...runtime,
        approvedByCallId: ctx.callId,
        executor: createHostedRuntimeSandboxExecutor({
          appId: selected.appId,
          authOrigin: provider.domain(input.port),
          provider,
          roles: input.roles,
          root: selected.root,
          signal: ctx.abortSignal,
          stateDirectory: runtime.stateDirectory,
        }),
        signal: ctx.abortSignal,
      });
    } catch (error) {
      if (error instanceof HostedRuntimeProviderError) {
        return { appId: input.appId, code: error.code, status: "blocked" as const };
      }
      return {
        appId: input.appId,
        code: "runtime_preparation_unavailable",
        status: "failed" as const,
      };
    }
  },
  inputSchema: hostedRuntimeApprovalInputSchema,
});
