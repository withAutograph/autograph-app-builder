import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectSupportedRepository } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Check a local repository against the pinned supported-template adapter without executing target-owned commands.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute({ path }) {
    return inspectSupportedRepository(path);
  },
});
