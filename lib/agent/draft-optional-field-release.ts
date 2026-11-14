import type { ToolContext } from "eve/tools";
import type { z } from "zod";

import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import {
  assertOptionalTextProductionTransition,
  readOptionalTextReleasePredecessor,
} from "../provisioning/repository-production-schema-revision";
import { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import type { directProductionSchemaChangeSchema } from "./direct-production-authorization";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";

/** Verify the sealed compiler output against its exact predecessor before offering approval. */
export const verifyDraftOptionalFieldRelease = async (
  ctx: ToolContext,
  candidate: DraftReconciliationCandidate,
  schemaChange: z.infer<typeof directProductionSchemaChangeSchema>,
  selection: Omit<CompiledOperatorReleaseSelection, "publishedSource">,
): Promise<"verified" | "incompatible" | "unavailable"> => {
  const session = {
    adapterSessionId: ctx.session.id,
    appId: candidate.appId,
    appSpecDigest: selection.appSpecDigest,
    callId: ctx.callId,
    callbackExecution: hostedOperatorCallbackExecution(ctx.session),
    root: candidate.root,
    sessionAuth: ctx.session.auth,
    signal: ctx.abortSignal,
  };
  try {
    const captured = await readExactCompiledOperatorReleaseForSession({
      ...session,
      lookup: { artifactRef: selection.artifactRef, appSpecDigest: selection.appSpecDigest },
    });
    if (
      captured?.selection.releaseId !== selection.releaseId ||
      captured.selection.manifestSha256 !== selection.manifestSha256 ||
      captured.selection.schemaSha256 !== selection.schemaSha256
    ) {
      return "unavailable";
    }
    const proof = readOptionalTextReleasePredecessor(captured.files);
    if (proof === null) {
      return "incompatible";
    }
    const prior = await readExactCompiledOperatorReleaseForSession({
      ...session,
      lookup: { releaseId: proof.releaseId, schemaSha256: proof.artifactSha256 },
    });
    if (prior === undefined) {
      return "unavailable";
    }
    try {
      assertOptionalTextProductionTransition({
        appId: candidate.appId,
        prior: { ...prior.selection, files: prior.files },
        candidate: { ...captured.selection, files: captured.files },
        ...schemaChange,
      });
    } catch {
      return "incompatible";
    }
    return "verified";
  } catch {
    ctx.abortSignal.throwIfAborted();
    return "unavailable";
  }
};
