import { defineState } from "eve/context";
import type { SourceReceipt } from "../repository/source-receipt";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { HostedTemplateFoundationResult } from "../repository/hosted-template-source-reconciliation";

/** Completed private source transitions are provenance, never new Build or publication authority. */
export interface HostedTemplateFoundationRecoveryReceipt {
  version: 1;
  appId: string;
  sessionId: string;
  workspaceId: string;
  appSpecDigest: string;
  proposalDigest: string;
  applyDigest: string;
  previousSourceReceipt: SourceReceipt;
  previousWorkspace: PreparedSandboxWorkspace;
  sourceReceipt: SourceReceipt;
  workspace: PreparedSandboxWorkspace;
  provenance: HostedTemplateFoundationResult["provenance"];
  recoveredByCallId: string;
}

export const hostedTemplateFoundationRecoveryHistory = defineState<
  readonly HostedTemplateFoundationRecoveryReceipt[]
>("autograph-app-builder.hosted-template-foundation-recovery.v1", () => []);
