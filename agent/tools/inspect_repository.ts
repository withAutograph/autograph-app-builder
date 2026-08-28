import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectSupportedRepository } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Check an allowlisted checkout visible to the app runtime against the pinned supported-template adapter without executing target-owned commands. Never pass /opt or /workspace paths; hosted source identity, prepared-workspace verification, and sandbox file reads belong to inspect_source, workspace_status, and read_file respectively.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute({ path }) {
    return inspectSupportedRepository(path);
  },
});
