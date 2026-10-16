import { defineTool } from "eve/tools";
import { authorizeHostedNeonForTool } from "@/lib/agent/hosted-neon-authorization";
import { z } from "zod";
import { hostedOperatorClientForSession } from "@/lib/provisioning/hosted-operator-client";
import type { OperatorSelection } from "@/lib/provisioning/hosted-operator-contract";
import {
  HostedOperatorError,
  hostedOperatorAuthSignupPolicyInputSchema,
} from "@/lib/provisioning/hosted-operator-contract";
import { withAppPublicationGuidance } from "@/lib/provisioning/hosted-operator-published-app-delivery";
import { normalActorProgramSchema } from "@/lib/provisioning/hosted-operator-normal-actor-program";

export default defineTool({
  description:
    "Read the protected operator's concrete Preview resource/access plan. For full hosted generated-app delivery, first publish the technically validated and reviewed source through the existing separately approved draft publication/update path and verify appSourceRecording is recorded; recover unavailable recording through that same approved publication. An app_source_publication_required result means continue that normal publication workflow in this same session, then plan again. Initial Auth/resource bootstrap may happen first. Hosted behavior remains unassessed until the delivered app is exercised. For signup, supply the product-approved organization, eligibility and initial app roles in authSignupPolicy; ordinary users are members, never owners. The policy is bound to the selected Auth resource, app and verified public origin and is persisted before signup is offered. Do not restrict ordinary signup to normalActorProgram test participants. For accepted product requirements needing named additional participants, derive normalActorProgram separately. After gateway_delivery_failed, plan again for the same app/session and accepted participant program to select the current trusted Gateway source; submit the returned plan and operation reference to prepare-app-hosted-runtime through its existing approval flow. An identical operation retains its durable approval; changed plans need ordinary approval. Unknown alias or hostname assignment outcomes require reconciliation. This planning call does not allocate resources or create accounts.",
  async execute(input, ctx) {
    const blocked = (code: HostedOperatorError["code"], selection?: OperatorSelection) =>
      withAppPublicationGuidance({
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
      const result = await operator.request(
        {
          action: "plan",
          ...(input.authSignupPolicy === undefined
            ? {}
            : { authSignupPolicy: input.authSignupPolicy }),
          ...(input.normalActorProgram === undefined
            ? {}
            : { normalActorProgram: input.normalActorProgram }),
          operation,
          selection,
        },
        ctx.abortSignal,
      );
      return withAppPublicationGuidance(result);
    } catch (error) {
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    authSignupPolicy: hostedOperatorAuthSignupPolicyInputSchema
      .extend({
        appPath: z
          .string()
          .regex(/^\/(?!\/)[^?#\\]*$/u)
          .default("/"),
      })
      .optional(),
    branch: z.string().min(1).optional(),
    environment: z.literal("preview"),
    operation: z.enum(["prepare", "cleanup"]),
    normalActorProgram: normalActorProgramSchema.optional(),
    projectId: z.string().min(1).optional(),
  }),
});
