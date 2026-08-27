import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { githubPublicationRuntime } from "@/lib/agent/github-publication-runtime";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export default defineTool({
  description:
    "After approval, resolve one installation-selected private GitHub repository ref to an exact immutable SHA/tree receipt. It does not clone, create, push, branch, open a PR, or alter a release gate.",
  inputSchema: z.strictObject({
    repositoryId: z.string().regex(/^\d+$/u),
    ref: z.string().min(1).max(255),
    expectedSha: objectId,
    expectedTree: objectId,
  }),
  approval: always(),
  async execute(input, ctx) {
    return githubPublicationRuntime.resolveImmutableSource({
      ...input,
      approvedByCallId: ctx.callId,
    });
  },
});
