import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { prepareSupportedWorkspace } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Create an isolated detached Git worktree at an already-reviewed eligible source SHA. This starts workspace execution and requires approval.",
  inputSchema: z.object({
    path: z.string().min(1),
    expectedSha: z.string().regex(/^[0-9a-f]{40}$/u),
  }),
  approval: always(),
  async execute({ path, expectedSha }) {
    return prepareSupportedWorkspace(path, expectedSha);
  },
});
