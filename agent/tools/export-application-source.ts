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
    const assertCurrent = () => {
      ctx.abortSignal?.throwIfAborted();
      if (!isDeepStrictEqual(current, appBuilderWorkflowState.get())) {
        throw new Error("The accepted app changed while saving source");
      }
    };
    const sandbox = await getSourceBoundSandbox(ctx);
    const captured = await captureApplicationSource({
      appId: current.appSpec.appId,
      assertCurrent,
      displayName,
      sandbox,
      signal: ctx.abortSignal ?? new AbortController().signal,
      sourceSessionId: ctx.session.id,
    });
    assertCurrent();
    const saved = await store.put(captured.artifact);
    assertCurrent();
    return applicationSourceExportReferenceSchema.parse({
      appId: current.appSpec.appId,
      bytes: saved.bytes,
      downloadPath: `/application-source/${encodeURIComponent(ctx.session.id)}/${saved.manifestDigest}`,
      fileCount: captured.files.length,
      kind: "application-source-export-v1",
      manifestDigest: saved.manifestDigest,
      omissionCount: captured.artifact.manifest.omissions.length,
      sourceSessionId: ctx.session.id,
    });
  },
  inputSchema: z.object({ displayName: z.string().min(1) }),
});
