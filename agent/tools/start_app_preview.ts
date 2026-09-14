import { defineTool } from "eve/tools";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { workingPreviewState } from "@/lib/agent/working-preview-state";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "@/lib/sandbox/vercel-preview-provider";
import { startWorkingPreview } from "@/lib/sandbox/working-preview-runtime";

export default defineTool({
  description:
    "Open the implemented app in its private Sandbox and return an actual working browser URL. Use the repository's discovered development command as executable plus argument array (no shell wrappers), from the applied repository root. Configure that command to listen on the supplied port; use landingPath for a nested app route. This uses the already-approved implementation, does not publish or provision app resources, and can reopen an expired preview. A reachable page is not proof of backend product behavior.",
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (!("applyReceipt" in current)) {
      throw new Error(
        "Build approval and an applied implementation are needed before opening the working app.",
      );
    }
    const sandbox = await ctx.getSandbox();
    await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
    const provider = await getVercelPreviewProvider(sandbox.id, ctx.abortSignal);
    const previous = workingPreviewState.get();
    workingPreviewState.update(() => null);
    const preview = await startWorkingPreview({
      ...input,
      appId: current.appSpec.appId,
      cwd: current.applyReceipt.applyRoot,
      previous,
      provider,
      sandboxId: sandbox.id,
      signal: ctx.abortSignal,
    });
    workingPreviewState.update(() => preview);
    return { workingPreview: preview.receipt };
  },
  inputSchema: z.object({
    command: z.object({
      args: z.array(z.string().max(8192)).max(256),
      executable: z.string().min(1).max(1024),
    }),
    landingPath: z.string().min(1).max(2048).default("/"),
    port: z.number().int().min(1024).max(65_535).default(3000),
  }),
});
