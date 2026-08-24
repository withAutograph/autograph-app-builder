import { createHash } from "node:crypto";

import { defineState } from "eve/context";

import type { PreparedSandboxWorkspace } from "@/lib/repository/supported-template";

export type AcceptedAppSpec = {
  appId: string;
  content: string;
  digest: string;
  acceptedByCallId: string;
};

export type AppCreationProposal = {
  version: 1;
  appId: string;
  appSpec: { path: string; sha256: string };
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
};

export type AppBuilderWorkflowState =
  | { version: 1; phase: "empty" }
  | ({
      version: 1;
      phase: "prepared";
      preparedByCallId: string;
    } & WorkspacePhase)
  | ({
      version: 1;
      phase: "app_spec_accepted";
      appSpec: AcceptedAppSpec;
    } & WorkspacePhase)
  | ({
      version: 1;
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
  "autograph-app-builder.workflow.v1",
  () => ({ version: 1, phase: "empty" }),
);
