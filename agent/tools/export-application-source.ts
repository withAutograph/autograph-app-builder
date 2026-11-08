import { defineTool } from "eve/tools";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { captureApplicationSource } from "@/lib/handoff/application-source-capture";
import { createLocalApplicationSourceStore } from "@/lib/handoff/local-application-source-store";
import { applicationSourceExportReferenceSchema } from "@/lib/handoff/application-source-contract";

export default defineTool({
  description:
    "Save the current accepted app's actual applied workspace as a portable source download when the user asks to save or transfer their local app. This captures app-owned code, binary assets and schema history, with credential/runtime/cache omissions reported in the manifest. It does not publish, deploy, start another session, or transfer identities, data, approvals or journal authority. Wait for pending apply/validation work to finish. Local development only; use the normal authenticated hosted flow for release.",
  inputSchema: z.object({ displayName: z.string().min(1) }),
  async execute({ displayName }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      !("appSpec" in current) ||
      !["applied", "validation_failed", "validated", "reviewed", "published_local"].includes(
        current.phase,
      )
    ) {
      throw new Error("Finish the accepted app's pending work before saving its source");
    }
    const store = createLocalApplicationSourceStore(process.env);
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    const assertCurrent = () => {
      ctx.abortSignal?.throwIfAborted();
      if (!isDeepStrictEqual(current, appBuilderWorkflowState.get())) {
        throw new Error("The accepted app changed while saving source");
      }
      return Promise.resolve();
    };
    const sandbox = await getSourceBoundSandbox(ctx);
    const captured = await captureApplicationSource({
      sandbox,
      appId: current.appSpec.appId,
      displayName,
      sourceSessionId: ctx.session.id,
      signal: ctx.abortSignal ?? new AbortController().signal,
      assertCurrent,
    });
    await assertCurrent();
    const saved = await store.put(captured.artifact);
    await assertCurrent();
    return applicationSourceExportReferenceSchema.parse({
      kind: "application-source-export-v1",
      appId: current.appSpec.appId,
      sourceSessionId: ctx.session.id,
      manifestDigest: saved.manifestDigest,
      downloadPath: `/application-source/${encodeURIComponent(ctx.session.id)}/${saved.manifestDigest}`,
      fileCount: captured.files.length,
      bytes: saved.bytes,
      omissionCount: captured.artifact.manifest.omissions.length,
    });
  },
});
