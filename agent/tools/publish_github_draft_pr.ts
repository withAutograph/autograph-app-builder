import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { githubPublicationRuntime } from "@/lib/agent/github-publication-runtime";

export default defineTool({
  description:
    "After separate approval of the exact sealed proposal digest, publish only the approved path set to a deterministic branch and open one draft pull request. It refuses stale base, overlap, collision, digest drift, or an enabled release gate.",
  inputSchema: z.strictObject({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute(input, ctx) {
    return githubPublicationRuntime.publishDraftPullRequest({
      ...input,
      approvedByCallId: ctx.callId,
    });
  },
});
