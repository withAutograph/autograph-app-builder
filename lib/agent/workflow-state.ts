import { createHash } from "node:crypto";

import { defineState } from "eve/context";

import type { PreparedSandboxWorkspace } from "@/lib/repository/supported-template";

export const APP_BUILDER_WORKFLOW_VERSION = 2 as const;

export type AcceptedAppSpec = {
  appId: string;
  artifactPath: string;
  content: string;
  digest: string;
  acceptedByCallId: string;
  artifactRevision: string;
};

export type PrototypeArtifact = {
  appId: string;
  path: string;
  mediaType: "text/markdown" | "text/html";
  content: string;
  digest: string;
  revision: string;
  sessionId: string;
  recordedByCallId: string;
};

export type AppCreationProposal = {
  version: 1;
  appId: string;
  appSpec: { path: string; sha256: string };
  artifactRevision: string;
  sourceSha: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  commands: {
    planning: string;
    apply: string;
    preflight: string;
    validation: readonly string[];
  };
  mutations: [];
  digest: string;
};

type WorkspacePhase = {
  workspace: PreparedSandboxWorkspace;
  preparedByCallId: string;
  artifacts: readonly PrototypeArtifact[];
};

export type AppBuilderWorkflowState =
  | { version: typeof APP_BUILDER_WORKFLOW_VERSION; phase: "empty" }
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "prepared";
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "app_spec_accepted";
      appSpec: AcceptedAppSpec;
    } & WorkspacePhase)
  | ({
      version: typeof APP_BUILDER_WORKFLOW_VERSION;
      phase: "planned";
      appSpec: AcceptedAppSpec;
      proposal: AppCreationProposal;
    } & WorkspacePhase);

export function workflowWorkspace(
  state: AppBuilderWorkflowState,
): PreparedSandboxWorkspace | undefined {
  return state.phase === "empty" ? undefined : state.workspace;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validAppId(appId: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId);
}

export const appBuilderWorkflowState = defineState<AppBuilderWorkflowState>(
  "autograph-app-builder.workflow.v2",
  () => ({ version: APP_BUILDER_WORKFLOW_VERSION, phase: "empty" }),
);
