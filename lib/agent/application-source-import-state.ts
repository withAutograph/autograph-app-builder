import { defineState } from "eve/context";
import type { z } from "zod";
import type { sourceCandidateReferenceSchema } from "../handoff/application-source-contract";

/** Uploaded bytes are application provenance, never a platform/Git/approval receipt. */
export interface ApplicationSourceImportReceipt {
  version: 1;
  kind: "application-source-import-v1";
  reference: z.infer<typeof sourceCandidateReferenceSchema>;
  sourceSessionId: string;
  importedSessionId: string;
  platformSourceReceiptDigest: string;
  workspaceId: string;
  appRoot: string;
  importedByCallId: string;
}
export const applicationSourceImportState = defineState<ApplicationSourceImportReceipt | undefined>(
  "autograph-app-builder.application-source-import.v1",
  // oxlint-disable-next-line unicorn/no-useless-undefined -- No import exists until owned source is materialized.
  () => undefined,
);
