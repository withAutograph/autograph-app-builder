import { defineTool } from "eve/tools";
import { z } from "zod";

import { sourceWorkflowState } from "@/lib/agent/source-state";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";

export default defineTool({
  description:
    "Inspect an explicitly allowlisted local checkout as either an existing repository or a fresh-template source and record its canonical release-disabled receipt. This never clones or materializes it.",
  inputSchema: z.object({
    sourceKind: z.enum(["existing-repository", "fresh-template"]),
    path: z.string().min(1),
  }),
  async execute({ sourceKind, path }) {
    const receipt = await inspectSourceReceipt(sourceKind, path);
    sourceWorkflowState.update(() => ({
      version: 1,
      phase: "reviewed",
      receipt,
    }));
    return receipt;
  },
});
