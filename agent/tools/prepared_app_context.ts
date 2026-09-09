import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { readPreparedAppContext } from "../../lib/agent/prepared-provider-context";

export default defineTool({
  description:
    "Read the app prepared on the web for this authenticated session, including its brief, existing resources, and current GitHub/Vercel access. Use these resources and connections to continue without provisioning or authorizing them again. This read-only tool grants no build or publication approval. Reconnect only when access requires authorization; retry provider outages.",
  inputSchema: z.strictObject({}),
  approval: never(),
  execute(_input, ctx) {
    return readPreparedAppContext(ctx.session.auth);
  },
});
