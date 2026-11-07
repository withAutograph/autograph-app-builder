import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { readPreparedHandoffContext } from "./handoff-context";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createSourceArtifactStore } from "../handoff/source-artifacts";
import { validateApplicationSourceArtifact } from "../handoff/application-source-bytes";
import { applicationSourceImportState } from "./application-source-import-state";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { materializeApplicationSource } from "../repository/application-source-import";
import type { SourceReceipt } from "../repository/source-receipt";
import type { ToolContext } from "eve/tools";

/** The actual authenticated handoff is read anew; no caller-supplied candidate grants access. */
export const importPreparedApplicationSource = async (
  ctx: ToolContext,
  platform: SourceReceipt,
) => {
  const intent = await readPreparedHandoffContext(ctx.session.auth);
  if (intent?.sourceCandidate === undefined) {
    return;
  }
  ctx.abortSignal.throwIfAborted();
  const { authority } = exactForwardedSessionAuthority(ctx.session.auth);
  const config = readPreviewOAuthRuntimeConfig(process.env);
  if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
    throw new Error("Application source authority unavailable.");
  }
  const store = createSourceArtifactStore(openHostedPostgresDatabase(config.databaseUrl));
  const candidate = await store.readCompleted({ authority, reference: intent.sourceCandidate });
  if (candidate === undefined) {
    throw new Error("Application source candidate unavailable.");
  }
  const validated = validateApplicationSourceArtifact(candidate);
  if (
    validated.manifestDigest !== intent.sourceCandidate.manifestDigest ||
    validated.artifact.manifest.appId !== intent.appId
  ) {
    throw new Error("Application source candidate changed.");
  }
  const sandbox = await ctx.getSandbox();
  const saved = applicationSourceImportState.get();
  const binding = {
    appRoot: `apps/${intent.appId}`,
    importedByCallId: saved?.importedByCallId ?? ctx.callId,
    importedSessionId: ctx.session.id,
    kind: "application-source-import-v1" as const,
    platformSourceReceiptDigest: platform.digest,
    reference: intent.sourceCandidate,
    sourceSessionId: validated.artifact.manifest.sourceSessionId,
    version: 1 as const,
    workspaceId: getBuilderSandboxId(sandbox),
  };
  if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(binding)) {
    throw new Error("This session already owns a different application source import.");
  }
  await materializeApplicationSource({
    abortSignal: ctx.abortSignal,
    assertCurrent: async () => {
      ctx.abortSignal.throwIfAborted();
      const current = await readPreparedHandoffContext(ctx.session.auth);
      if (JSON.stringify(current?.sourceCandidate) !== JSON.stringify(intent.sourceCandidate)) {
        throw new Error("Application source owner changed.");
      }
    },
    receipt: binding,
    sandbox,
    validated,
  });
  // Owner and current membership are rechecked after the private write and before accepting it.
  const after = await readPreparedHandoffContext(ctx.session.auth);
  if (JSON.stringify(after?.sourceCandidate) !== JSON.stringify(intent.sourceCandidate)) {
    throw new Error("Application source owner changed.");
  }
  applicationSourceImportState.update(() => binding);
};
