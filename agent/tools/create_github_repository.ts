import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { githubPublicationRuntime } from "@/lib/agent/github-publication-runtime";

export default defineTool({
  description:
    "After approval of the exact sealed proposal digest, create one private fresh-history repository through the selected GitHub App installation. The release gate must remain absent. This tool cannot publish a branch or PR.",
  inputSchema: z.strictObject({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute(input, ctx) {
    return githubPublicationRuntime.createFreshRepository({
      ...input,
      approvedByCallId: ctx.callId,
    });
  },
});
