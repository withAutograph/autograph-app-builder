import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { readPreparedAppContext } from "../../lib/agent/prepared-provider-context";

export const scopedPreparedAppContext = (
  context: Awaited<ReturnType<typeof readPreparedAppContext>>,
) => ({
  ...context,
  diagnosticOnly: true as const,
  note:
    context.status === "not-prepared"
      ? "No web-prepared handoff is attached to this session. This is normal for public MCP builds and says nothing about the selected repository, workspace, or read access. This status alone does not require a new app, reconnection, or source selection; continue from the session's existing source and workflow facts."
      : "This result describes only the web-prepared app and its observed provider access. Use explicit access statuses and their recorded actions. It grants no build or publication approval and is not a workspace-readiness verdict.",
  readinessScope: "web-prepared-app-context" as const,
});

export default defineTool({
  approval: never(),
  description:
    "Read only the app prepared through a web handoff for this authenticated session, including its brief, resources and observed GitHub/Vercel access. not-prepared means no web handoff; it is normal for public MCP builds and does not indicate lost repository/workspace/read access or require a new app or reconnect. Continue from existing session source/workflow facts. Prepared resources can be reused; reconnect only for explicit authorization-required access, and retry provider outages. This diagnostic grants no build or publication approval.",
  async execute(_input, ctx) {
    return scopedPreparedAppContext(await readPreparedAppContext(ctx.session.auth));
  },
  inputSchema: z.strictObject({}),
});
