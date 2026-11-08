import { createHash } from "node:crypto";
import type { AcceptedAppSpec, PreparedAppCreation } from "./workflow-state";
import type { SourceReceipt } from "../repository/source-receipt";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { TargetApplyReceipt } from "../repository/target-apply";

interface LocalPlanningSourceBaseState {
  appSpec: Pick<AcceptedAppSpec, "appId" | "digest" | "artifactRevision">;
  sourceReceipt: Pick<SourceReceipt, "sourceSha" | "digest">;
  workspace: Pick<
    PreparedSandboxWorkspace,
    "sourceSha" | "workspaceDigest" | "workspaceId" | "workspacePath"
  >;
  proposal?: Pick<
    PreparedAppCreation,
    | "digest"
    | "sourceSha"
    | "sourceReceiptDigest"
    | "workspaceDigest"
    | "appSpecDigest"
    | "artifactRevision"
  > & { target: { contract: { appId: string } } };
  applyReceipt?: Pick<
    TargetApplyReceipt,
    | "proposalDigest"
    | "sourceSha"
    | "workspaceDigest"
    | "sourceReceiptDigest"
    | "appSpecDigest"
    | "applyRoot"
  >;
}
interface LocalPlanningBase {
  sourceSha: string;
  workspaceDigest: string;
  workspaceId: string;
  sourceOverlay?: { sourceSha: string; workspaceDigest: string };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Saved proposal/apply provenance survives later live workspace overlays. Never use mixed candidate files as an old base. */
export const localPlanningSourceBase = (
  current: LocalPlanningSourceBaseState,
  completedTransport?: Pick<
    PreparedSandboxWorkspace,
    "workspaceId" | "workspacePath" | "sourceSha" | "workspaceDigest"
  >,
) => {
  if (
    completedTransport !== undefined &&
    (completedTransport.workspaceId !== current.workspace.workspaceId ||
      completedTransport.workspacePath !== current.workspace.workspacePath)
  ) {
    throw new Error("The completed local source transport belongs to another workspace.");
  }
  const transported = completedTransport ?? current.workspace;
  const base = current.proposal ?? current.workspace;
  if (base.sourceSha !== current.sourceReceipt.sourceSha) {
    throw new Error(
      "The retained local planning source no longer matches its original source receipt.",
    );
  }
  if (current.proposal !== undefined) {
    const { digest, ...unsigned } = current.proposal;
    const proposalMatches = [
      digest === hash(JSON.stringify(unsigned)),
      current.proposal.sourceReceiptDigest === current.sourceReceipt.digest,
      current.proposal.appSpecDigest === current.appSpec.digest,
      current.proposal.artifactRevision === current.appSpec.artifactRevision,
      current.proposal.target.contract.appId === current.appSpec.appId,
    ].every(Boolean);
    if (!proposalMatches) {
      throw new Error(
        "The saved original planning provenance is unavailable; the candidate is retained.",
      );
    }
    if (current.applyReceipt !== undefined) {
      const applyMatches = [
        current.applyReceipt.proposalDigest === digest,
        current.applyReceipt.sourceSha === base.sourceSha,
        current.applyReceipt.workspaceDigest === base.workspaceDigest,
        current.applyReceipt.sourceReceiptDigest === current.sourceReceipt.digest,
        current.applyReceipt.appSpecDigest === current.appSpec.digest,
        current.applyReceipt.applyRoot === current.workspace.workspacePath,
      ].every(Boolean);
      if (!applyMatches) {
        throw new Error(
          "The saved apply provenance does not match its original local planning base.",
        );
      }
    }
  }
  const result: LocalPlanningBase = {
    sourceSha: base.sourceSha,
    workspaceDigest: base.workspaceDigest,
    workspaceId: current.workspace.workspaceId,
  };
  if (transported.workspaceDigest !== base.workspaceDigest) {
    result.sourceOverlay = {
      sourceSha: transported.sourceSha,
      workspaceDigest: transported.workspaceDigest,
    };
  }
  return result;
};
