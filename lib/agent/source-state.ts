import { defineState } from "eve/context";

import type { SourceReceipt } from "@/lib/repository/source-receipt";

export const APP_BUILDER_SOURCE_VERSION = 3 as const;

export type SourceWorkflowState =
  | { version: typeof APP_BUILDER_SOURCE_VERSION; phase: "empty" }
  | {
      version: typeof APP_BUILDER_SOURCE_VERSION;
      phase: "reviewed" | "acquisition_approved";
      receipt: SourceReceipt;
      approvedByCallId?: string;
    };

export const sourceWorkflowState = defineState<SourceWorkflowState>(
  "autograph-app-builder.source.v3",
  () => ({ version: APP_BUILDER_SOURCE_VERSION, phase: "empty" }),
);
