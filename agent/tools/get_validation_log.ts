import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  assertValidationLogSession,
  validationLogStoreForSession,
} from "@/lib/agent/validation-log-store-for-session";
import { readValidationLogPage } from "@/lib/repository/validation-log";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export const validationLogInputSchema = z.union([
  z.strictObject({
    attemptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    channel: z.enum(["stdout", "stderr"]),
    command: z.enum(["check-build", "test", "dependency-probe", "dependency-install"]),
    cursor: z.string().max(128).optional(),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    logId: z.uuid(),
  }),
  z.strictObject({ operation: z.literal("dependency-attempts") }),
]);

export default defineTool({
  description:
    "Read one authenticated page of a saved validation or dependency command log after execution or sandbox cleanup. To recover saved dependency references, first use operation: dependency-attempts. For pages supply the exact attempt, command, channel, log ID and digest. Continue with each nextCursor and verify assembled UTF-8 SHA-256 against digest. Page complete means the manifest is exhausted; completion distinguishes complete capture, interrupted output, and an unavailable durable suffix.",
  async execute(input, ctx) {
    if ("operation" in input) {
      await assertValidationLogSession({
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      const state = appBuilderWorkflowState.get();
      return { attempts: state.phase === "empty" ? [] : (state.checkoutDependencyAttempts ?? []) };
    }
    const store = await validationLogStoreForSession({
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
  inputSchema: validationLogInputSchema,
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
