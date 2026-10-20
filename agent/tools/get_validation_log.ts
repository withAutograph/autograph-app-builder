import {
  validationAttemptLogReadInputs,
  validationLogReadInput,
} from "@/lib/agent/validation-log-read-input";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  assertValidationLogSession,
  validationLogStoreForSession,
} from "@/lib/agent/validation-log-store-for-session";
import { readValidationLogPage } from "@/lib/repository/validation-log";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { candidateValidationAttemptHistory } from "@/lib/agent/draft-reconciliation-state";

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
  z.strictObject({ operation: z.literal("validation-attempts") }),
]);

export default defineTool({
  description:
    "Read one authenticated page of a saved validation or dependency command log after execution or sandbox cleanup. To recover saved validation references, use operation: validation-attempts and copy a complete channel readInput. Discovery lists retained workflow receipts and historical supported candidate check/test attempts, including attempts from before a source repair or validation reset. Historical candidate attempts are evidence of that execution only, not current validation. For saved dependency references, use operation: dependency-attempts. For pages supply the exact attempt, command, channel, log ID and digest. Continue with each nextCursor and verify assembled UTF-8 SHA-256 against digest. Page complete means the manifest is exhausted; completion distinguishes complete capture, interrupted output, and an unavailable durable suffix.",
  async execute(input, ctx) {
    if ("operation" in input) {
      await assertValidationLogSession({
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      const state = appBuilderWorkflowState.get();
      if (input.operation === "dependency-attempts") {
        return {
          attempts: state.phase === "empty" ? [] : (state.checkoutDependencyAttempts ?? []),
        };
      }
      const candidateAttempts = candidateValidationAttemptHistory.get().map((attempt) => ({
        attemptDigest: attempt.attemptDigest,
        commands: [
          {
            category: attempt.category,
            command: attempt.command,
            completion: attempt.completion,
            durability: attempt.durability,
            exitCode: attempt.exitCode,
            logs: Object.fromEntries(
              Object.entries(attempt.logs).map(([channel, reference]) => [
                channel,
                reference === undefined
                  ? undefined
                  : {
                      ...reference,
                      readInput: validationLogReadInput(
                        attempt.attemptDigest,
                        attempt.category,
                        reference,
                      ),
                    },
              ]),
            ),
            name: attempt.category,
          },
        ],
        identity: {
          appId: attempt.appId,
          baseSha: attempt.baseSha,
          callId: attempt.callId,
          githubSourceDigest: attempt.githubSourceDigest,
          headSha: attempt.headSha,
          originalReviewDigest: attempt.originalReviewDigest,
          pullRequestNumber: attempt.pullRequestNumber,
          repositoryId: attempt.repositoryId,
          resolvedTree: attempt.resolvedTree,
        },
        status: attempt.completion === "complete" && attempt.exitCode === 0 ? "passed" : "failed",
      }));
      if (state.phase === "validation_failed") {
        return {
          attempts: [...candidateAttempts, validationAttemptLogReadInputs(state.validationFailure)],
        };
      }
      if ("validationReceipt" in state) {
        return {
          attempts: [...candidateAttempts, validationAttemptLogReadInputs(state.validationReceipt)],
        };
      }
      return { attempts: candidateAttempts };
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
