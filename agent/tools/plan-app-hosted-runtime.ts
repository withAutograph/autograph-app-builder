import { defineTool } from "eve/tools";
import { authorizeHostedNeonForTool } from "@/lib/agent/hosted-neon-authorization";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import type { OperatorSelection } from "@/lib/provisioning/hosted-operator-contract";
import { HostedOperatorError } from "@/lib/provisioning/hosted-operator-contract";
import { normalActorProgramSchema } from "@/lib/provisioning/hosted-operator-normal-actor-program";

export default defineTool({
  description:
    "Read the protected operator's concrete Preview resource/access plan before asking for effect approval. Returns named targets, roles, effects, cost ownership, retention and an opaque operation reference. Supply appId; omit projectId and branch to resolve the configured owner-authorized Preview target. Explicit project or branch choices must match that target. For accepted product requirements needing several authenticated participants, derive normalActorProgram from the accepted account, organization, membership and app-role requirements and supply that program. Its origin must be the operator's verified native public origin. First approve normal account preparation; after participants-prepared, plan again using the same program and session to obtain the resolved organization, invitation, membership and app access approval before those writes. The Builder owns this preparation; ordinary public product replies supply its requirements. This planning call does not allocate resources or create accounts.",
  async execute(input, ctx) {
    const blocked = (code: HostedOperatorError["code"], selection?: OperatorSelection) => ({
      appId: input.appId,
      authenticatedBehavior: "unassessed" as const,
      code,
      status: "blocked" as const,
      ...(selection === undefined ? {} : { approvedPreviewTarget: selection }),
    });
    let operator;
    try {
      operator = await hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
    } catch (error) {
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
    const { operation } = input;
    if (operation === "prepare") {
      // Leave Eve's authorization control flow outside the ordinary blocked-result catch.
      const authorizationFailure = await authorizeHostedNeonForTool(ctx, operator);
      if (authorizationFailure !== null) {
        return blocked(authorizationFailure);
      }
    }
    try {
      const selection = await operator.resolvePreviewTarget(
        {
          action: "resolve-preview-target",
          appId: input.appId,
          sessionId: operator.sessionId ?? ctx.session.id,
        },
        ctx.abortSignal,
      );
      if (
        (input.projectId !== undefined && input.projectId !== selection.projectId) ||
        (input.branch !== undefined && input.branch !== selection.branch)
      ) {
        return blocked("resource_mismatch", selection);
      }
      return await operator.request(
        {
          action: "plan",
          ...(input.normalActorProgram === undefined
            ? {}
            : { normalActorProgram: input.normalActorProgram }),
          operation,
          selection,
        },
        ctx.abortSignal,
      );
    } catch (error) {
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    branch: z.string().min(1).optional(),
    environment: z.literal("preview"),
    operation: z.enum(["prepare", "cleanup"]),
    normalActorProgram: normalActorProgramSchema.optional(),
    projectId: z.string().min(1).optional(),
  }),
});
