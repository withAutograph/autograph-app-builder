import { isDeepStrictEqual } from "node:util";
import type { SourceReceipt } from "../repository/source-receipt";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { ValidationExecutionFoundation } from "../repository/target-validation";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import { hostedTemplateFoundationRecoveryHistory } from "./hosted-template-foundation-recovery-state";

type AppliedBinding = Pick<
  Extract<AppBuilderWorkflowState, { phase: "applied" }>,
  "appSpec" | "workspace" | "sourceReceipt" | "proposal" | "applyReceipt"
> &
  Partial<Pick<Extract<AppBuilderWorkflowState, { phase: "applied" }>, "githubSource">>;
export interface HostedTemplateFoundationBinding {
  approvedSourceReceipt: SourceReceipt;
  approvedWorkspace: PreparedSandboxWorkspace;
  currentSourceReceipt: SourceReceipt;
  currentWorkspace: PreparedSandboxWorkspace;
  executionFoundation: ValidationExecutionFoundation;
}
const freshTemplate = "fresh-template";
const unavailable = () =>
  new Error("The completed source recovery does not match this retained approved app.");

/** Bridge an original private Build to its completed, same-owned-app source transitions only. */
export const resolveHostedTemplateFoundationBinding = (
  state: AppliedBinding,
  sessionId: string,
): HostedTemplateFoundationBinding | undefined => {
  if (
    state.sourceReceipt.sourceKind !== freshTemplate ||
    state.githubSource !== undefined ||
    state.applyReceipt.sourceReceiptDigest === state.sourceReceipt.digest
  ) {
    return undefined;
  }
  const { appSpec, proposal, applyReceipt, workspace } = state;
  assertApprovedPrivateApplySession({
    appId: appSpec.appId,
    appSpecDigest: appSpec.digest,
    proposalDigest: proposal.digest,
    sessionId,
    workspaceId: workspace.workspaceId,
  });
  const history = hostedTemplateFoundationRecoveryHistory
    .get()
    .filter((entry) =>
      [
        entry.appId === appSpec.appId,
        entry.sessionId === sessionId,
        entry.workspaceId === workspace.workspaceId,
        entry.appSpecDigest === appSpec.digest,
        entry.proposalDigest === proposal.digest,
        entry.applyDigest === applyReceipt.digest,
      ].every(Boolean),
    );
  const [first] = history;
  if (first === undefined) {
    throw unavailable();
  }
  const approvedSourceReceipt = first.previousSourceReceipt;
  const approvedWorkspace = first.previousWorkspace;
  const originalBinding = [
    proposal.appSpecDigest === appSpec.digest,
    proposal.artifactRevision === appSpec.artifactRevision,
    proposal.target.contract.appId === appSpec.appId,
    proposal.target.contract.appSpec.path === appSpec.artifactPath,
    proposal.target.contract.appSpec.sha256 === appSpec.digest,
    proposal.sourceReceiptDigest === approvedSourceReceipt.digest,
    proposal.sourceSha === approvedSourceReceipt.sourceSha,
    proposal.sourceTree === approvedSourceReceipt.sourceTree,
    proposal.workspaceDigest === approvedWorkspace.workspaceDigest,
    applyReceipt.proposalDigest === proposal.digest,
    applyReceipt.appSpecDigest === appSpec.digest,
    applyReceipt.appSpecPath === appSpec.artifactPath,
    applyReceipt.artifactRevision === appSpec.artifactRevision,
    applyReceipt.sourceReceiptDigest === approvedSourceReceipt.digest,
    applyReceipt.sourceSha === approvedSourceReceipt.sourceSha,
    applyReceipt.sourceTree === approvedSourceReceipt.sourceTree,
    applyReceipt.workspaceDigest === approvedWorkspace.workspaceDigest,
    applyReceipt.applyRoot === workspace.workspacePath,
    approvedWorkspace.workspaceId === workspace.workspaceId,
    approvedWorkspace.workspacePath === workspace.workspacePath,
    approvedSourceReceipt.sourceKind === freshTemplate,
    approvedWorkspace.sourceSha === approvedSourceReceipt.sourceSha,
    approvedWorkspace.sourceTree === approvedSourceReceipt.sourceTree,
  ].every(Boolean);
  if (!originalBinding) {
    throw unavailable();
  }
  let source = approvedSourceReceipt;
  let currentWorkspace = approvedWorkspace;
  for (const entry of history) {
    const sameTransition = [
      isDeepStrictEqual(entry.previousSourceReceipt, source),
      isDeepStrictEqual(entry.previousWorkspace, currentWorkspace),
      entry.sourceReceipt.sourceKind === freshTemplate,
      entry.workspace.workspaceId === workspace.workspaceId,
      entry.workspace.workspacePath === workspace.workspacePath,
      entry.workspace.sourceSha === entry.sourceReceipt.sourceSha,
      entry.workspace.sourceTree === entry.sourceReceipt.sourceTree,
      entry.provenance.previousSourceReceiptDigest === source.digest,
      entry.provenance.previousWorkspaceDigest === currentWorkspace.workspaceDigest,
      entry.provenance.previousSourceSha === source.sourceSha,
      entry.provenance.sourceSha === entry.sourceReceipt.sourceSha,
      entry.provenance.sourceTree === entry.sourceReceipt.sourceTree,
    ].every(Boolean);
    if (!sameTransition) {
      throw unavailable();
    }
    source = entry.sourceReceipt;
    currentWorkspace = entry.workspace;
  }
  if (
    !isDeepStrictEqual(source, state.sourceReceipt) ||
    !isDeepStrictEqual(currentWorkspace, state.workspace)
  ) {
    throw unavailable();
  }
  return {
    approvedSourceReceipt,
    approvedWorkspace,
    currentSourceReceipt: source,
    currentWorkspace,
    executionFoundation: {
      sourceReceiptDigest: source.digest,
      sourceSha: source.sourceSha,
      sourceTree: source.sourceTree,
      eligibilityDigest: currentWorkspace.eligibilityDigest,
      workspaceDigest: currentWorkspace.workspaceDigest,
    },
  };
};
