import { defineState } from "eve/context";

import type { SourceReceipt } from "@/lib/repository/source-receipt";

export type SourceWorkflowState =
  | { version: 1; phase: "empty" }
  | {
      version: 1;
      phase: "reviewed" | "acquisition_approved";
      receipt: SourceReceipt;
      approvedByCallId?: string;
    };

export const sourceWorkflowState = defineState<SourceWorkflowState>(
  "autograph-app-builder.source.v1",
  () => ({ version: 1, phase: "empty" }),
);
