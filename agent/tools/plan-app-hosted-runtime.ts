import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { getBuilderSandboxId } from "@/lib/sandbox/builder-sandbox";
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
import {
  reportContinuityPlanningFailure,
  reportExportPlanningFailure,
} from "@/lib/provisioning/hosted-operator-consent-diagnostic";
import type {
  ContinuityPlanningStage,
  ExportPlanningStage,
} from "@/lib/provisioning/hosted-operator-consent-diagnostic";

export default defineTool({
  description:
    "Read the protected operator's concrete Preview resource/access plan. For restoration or use of the unchanged prepared published Preview, set releaseIntent to prepared-preview. This selects its exact frozen approved release and matching recorded publication; validating or publishing a newer private capture is not a prerequisite. Preserve that unpublished candidate for later work. Distinguish restoring an existing delivery from repairing app or shared framework software. When an identified shared framework repair must be adopted by an app with its own published draft, use prepare_github_draft_pr_reconciliation to merge the current base into that same owned draft while preserving the app's source and registration. Complete the existing candidate validation, review and approved publication/update flow, then verify appSourceRecording is recorded and plan changed-source delivery without releaseIntent. A Gateway-only refresh of the frozen publication does not adopt that software repair; selecting a plain platform commit can omit the app's registration. Resolve source selection through Builder's supported tools without asking the user for technical references. A browser or provider error alone does not establish a source defect or require a source update. For delivery of changed source, omit releaseIntent, publish the technically validated and reviewed source through the existing separately approved draft publication/update path, and verify appSourceRecording is recorded. For app_source_publication_required during changed-source delivery, inspect_github_draft_pr_reconciliation with kind publication-recovery can discover retained completion context. Copy its returned nextCall through normal approval and exact provider verification to record only an equivalent current release. Listed receipts grant no authority. If no matching context is available, continue normal source-recording recovery in this same session without inventing a publication or republishing an already accepted result. Then plan again. An auth-bootstrap plan intentionally prepares Auth and Gateway before account capture; app installation, access, delivery and routing follow in a renewed full app plan. Continue the returned prerequisite through prepare-app-hosted-runtime with approval for its exact effects, follow its ordinary account sign-in link for the existing account, and resume the same approved preparation to read back capture. Then plan again for the same app/session and release intent to obtain the app delivery and routing effects through their normal approval flow. A first bootstrap-only plan is not a missing app recovery plan, and an app deployment is not required before the initial account connection. Preserve unknown outcomes for reconciliation. Hosted behavior remains unassessed until the delivered app is exercised. For signup, supply the product-approved organization, eligibility and initial app roles in authSignupPolicy; ordinary users are members, never owners. The policy is bound to the selected Auth resource, app and verified public origin and is persisted before signup is offered. Do not restrict ordinary signup to normalActorProgram test participants. For accepted product requirements needing named additional participants, derive normalActorProgram separately. After gateway_delivery_failed, plan again for the same app/session and accepted participant program to select the current trusted Gateway source; submit the returned plan and operation reference to prepare-app-hosted-runtime through its existing approval flow. An identical operation retains its durable approval; changed plans need ordinary approval. Unknown alias or hostname assignment outcomes require reconciliation. For a manual data export, use operation export with the explicitly requested customerId, or customerScope owner-organization when the user chooses their original owner organization. The server resolves that semantic choice from approved historical owner identity into an exact currently approved installed tenant, never the first QA organization. If export_customer_selection_required is returned, ask which organization by its product name; never guess an opaque ID. Keep the raw customerId path for an explicitly selected tenant. In either case, the server freezes the currently prepared app resource and release plus private owner-only destination. Submit its exact request and returned plan to export-app-hosted-data for separate data-export approval. For the explicitly requested manual continuity exercise, operation continuity resolves the current owned app checkout and prepared runtime. Submit its exact plan/request to run-app-continuity-tests for separate approval. It runs one app-authored suite through an owned managed process, briefly publishes an isolated Gateway target, then closes that runtime and removes only its own configuration rows; it does not redeploy the native app or prove later native continuity. This planning call does not allocate resources or create accounts.",
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Best-effort continuity diagnostic guards preserve the existing operation and authorization branches.
  async execute(input, ctx) {
    const blocked = (code: HostedOperatorError["code"], selection?: OperatorSelection) =>
      withAppPublicationGuidance({
        appId: input.appId,
        authenticatedBehavior: "unassessed" as const,
        code,
        status: "blocked" as const,
        ...(code === "export_customer_selection_required"
          ? {
              nextAction:
                "Name the organization to export. No export was planned or data extracted.",
            }
          : {}),
        ...(selection === undefined ? {} : { approvedPreviewTarget: selection }),
      });
    let operator;
    try {
      operator = await hostedOperatorClientForSession(
        ctx.session.auth,
        ctx.session.id,
        process.env,
        hostedOperatorCallbackExecution(ctx.session),
      );
    } catch (error) {
      try {
        if (input.operation === "continuity") {
          reportContinuityPlanningFailure(ctx.session.id, "tool_client_resolution", error);
        } else if (input.operation === "export") {
          reportExportPlanningFailure(ctx.session.id, "tool_client_resolution", error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
    const { operation } = input;
    const reportExportFailure = (
      stage: ExportPlanningStage,
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Diagnostic rejection boundaries classify arbitrary thrown values without exposing them.
      error: unknown,
    ) => {
      try {
        if (operation === "export") {
          reportExportPlanningFailure(operator.sessionId ?? ctx.session.id, stage, error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original blocked result. */
      }
    };
    if (operation === "prepare") {
      // Leave Eve's authorization control flow outside the ordinary blocked-result catch.
      const authorizationFailure = await authorizeHostedNeonForTool(ctx, operator);
      if (authorizationFailure !== null) {
        return blocked(authorizationFailure);
      }
    }
    let continuityStage: ContinuityPlanningStage = "tool_preview_target";
    let exportStage: ExportPlanningStage = "tool_preview_target";
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
        try {
          const mismatchStage =
            input.projectId !== undefined && input.projectId !== selection.projectId
              ? "tool_project_mismatch"
              : "tool_branch_mismatch";
          reportExportFailure(mismatchStage, new HostedOperatorError("resource_mismatch"));
        } catch {
          /* Diagnostic context lookup must preserve the original blocked result. */
        }
        return blocked("resource_mismatch", selection);
      }
      if (operation === "continuity") {
        continuityStage = "tool_local_sandbox";
        const sandbox = await ctx.getSandbox();
        continuityStage = "tool_selected_app";
        const selected = await runnableSelectedApp({
          appId: input.appId,
          sandbox,
          state: appBuilderWorkflowState.get(),
        });
        continuityStage = "tool_sandbox_identity";
        const runtime = { sandboxId: getBuilderSandboxId(sandbox), root: selected.root };
        continuityStage = "tool_plan_request";
        return await operator.planContinuity(selection, runtime, ctx.callId, ctx.abortSignal);
      }
      if (operation === "export") {
        if (input.customerId === undefined && input.customerScope === undefined) {
          reportExportFailure(
            "tool_missing_customer",
            new HostedOperatorError("resource_mismatch"),
          );
          return blocked("resource_mismatch", selection);
        }
        exportStage = "tool_plan_request";
        return await operator.planTenantExport(
          selection,
          input.customerId ?? { kind: "owner-organization" },
          ctx.callId,
          ctx.abortSignal,
        );
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
          ...(input.releaseIntent === undefined ? {} : { releaseIntent: input.releaseIntent }),
          selection,
        },
        ctx.abortSignal,
      );
      return withAppPublicationGuidance(result);
    } catch (error) {
      try {
        if (operation === "continuity") {
          reportContinuityPlanningFailure(ctx.session.id, continuityStage, error);
        } else if (operation === "export") {
          reportExportFailure(exportStage, error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      return blocked(error instanceof HostedOperatorError ? error.code : "operator_unavailable");
    }
  },
  inputSchema: z
    .strictObject({
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
      operation: z.enum(["prepare", "cleanup", "export", "continuity"]),
      releaseIntent: z.literal("prepared-preview").optional(),
      customerId: z.string().min(1).optional(),
      customerScope: z.literal("owner-organization").optional(),
      normalActorProgram: normalActorProgramSchema.optional(),
      projectId: z.string().min(1).optional(),
    })
    .refine(
      (input) => input.customerId === undefined || input.customerScope === undefined,
      "Select one export customer scope.",
    ),
});
