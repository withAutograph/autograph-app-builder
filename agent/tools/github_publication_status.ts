import { defineTool } from "eve/tools";
import { z } from "zod";

import { githubPublicationRuntime } from "@/lib/agent/github-publication-runtime";

export default defineTool({
  description:
    "Report the typed least-privilege GitHub acquisition/publication capability without reading credentials, calling GitHub, or mutating any repository, branch, pull request, release gate, or provider state.",
  inputSchema: z.strictObject({}),
  async execute() {
    return githubPublicationRuntime.status();
  },
});
