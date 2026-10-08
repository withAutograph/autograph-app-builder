import { defineState } from "eve/context";

export interface PreparedRuntimeSelection {
  appId: string;
  branch: string;
  projectId: string;
  sessionId: string;
  operationRef?: string;
  planDigest?: string;
}

/** Approval selection only. Credentials and protected files stay outside Eve state. */
export const preparedRuntimeSelections = defineState<Record<string, PreparedRuntimeSelection>>(
  "autograph-app-builder.prepared-runtime-selections.v1",
  () => ({}),
);
