import { defineTool } from "eve/tools";
import { z } from "zod";

import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { createPostgresValidationLogStore } from "@/lib/repository/postgres-validation-log-store";
import { readValidationLogPage } from "@/lib/repository/validation-log";

export default defineTool({
  description:
    "Read one authenticated page of a saved validation command log after execution or sandbox cleanup. Supply the exact attempt, command, channel, log ID and digest returned by validation. Continue with each nextCursor and verify the assembled UTF-8 SHA-256 against digest.",
  async execute(input, ctx) {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error("Durable validation log storage is unavailable.");
    }
    const store = createPostgresValidationLogStore({
      db: openHostedPostgresDatabase(databaseUrl),
      sessionAuth: ctx.session.auth,
      sessionId: ctx.session.id,
    });
    return await readValidationLogPage({
      cursor: input.cursor,
      digest: input.digest,
      key: {
        attemptDigest: input.attemptDigest,
        channel: input.channel,
        command: input.command,
        logId: input.logId,
        sessionId: ctx.session.id,
      },
      store,
    });
  },
  inputSchema: z.strictObject({
    attemptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    channel: z.enum(["stdout", "stderr"]),
    command: z.enum(["check-build", "test"]),
    cursor: z.string().max(128).optional(),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    logId: z.uuid(),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
