/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";

export default defineTool({
  description:
    "Report the typed least-privilege GitHub acquisition/publication capability without reading credentials, calling GitHub, or mutating any repository, branch, pull request, release gate, or provider state.",
  async execute(_input, ctx) {
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    return await runtime.status();
  },
  inputSchema: z.strictObject({}),
});
