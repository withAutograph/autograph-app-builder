import { defineState } from "eve/context";

import type { PreparedSandboxWorkspace } from "@/lib/repository/supported-template";

export type AppBuilderWorkflowState =
  | { version: 1; phase: "empty" }
  | {
      version: 1;
      phase: "prepared";
      preparedByCallId: string;
      workspace: PreparedSandboxWorkspace;
    };

export const appBuilderWorkflowState = defineState<AppBuilderWorkflowState>(
  "autograph-app-builder.workflow.v1",
  () => ({ version: 1, phase: "empty" }),
);
