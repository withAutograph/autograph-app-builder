import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectSupportedRepository } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Check an allowlisted checkout visible to the app runtime against the pinned supported-template adapter without executing target-owned commands. Never pass /opt or /workspace paths; hosted source identity and prepared-workspace verification belong to inspect_source and workspace_status, while existing app file inspection belongs to inspect_existing_app.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute({ path }) {
    return inspectSupportedRepository(path);
  },
});
