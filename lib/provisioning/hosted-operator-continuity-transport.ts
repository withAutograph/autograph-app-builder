import { reportContinuityPlanningFailure } from "./hosted-operator-consent-diagnostic";
import type { ContinuityPlanningStage } from "./hosted-operator-consent-diagnostic";
import { z } from "zod";
import {
  operatorOwnerContextSchema,
  operatorSelectionSchema,
  HostedOperatorError,
} from "./hosted-operator-contract";
import {
  hostedContinuityRequestSchema,
  hostedContinuityPlanSchema,
  continuityStatusSchema,
  continuityRuntimeSelectionSchema,
} from "./hosted-operator-continuity-contract";
import type {
  createHostedContinuityOperations,
  ContinuityJournalStore,
} from "./hosted-operator-continuity";
import type {
  ProtectedHostedOperatorDependencies,
  HostedOperatorContext,
} from "./hosted-operator-service";

export const continuityTransportRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...hostedContinuityRequestSchema.shape,
    action: z.literal("continuity-approval"),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal("continuity-plan"),
    selection: operatorSelectionSchema,
    runtime: continuityRuntimeSelectionSchema,
    idempotencyKey: z.string().min(1),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal("continuity-status"),
    intentId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    ...hostedContinuityRequestSchema.shape,
    callId: z.string().min(1),
    ownerContext: operatorOwnerContextSchema,
  }),
]);
export const continuityPlannedSchema = z.strictObject({
  plan: hostedContinuityPlanSchema,
  request: hostedContinuityRequestSchema,
  status: continuityStatusSchema,
});

export type ContinuityTransportRequest = z.infer<typeof continuityTransportRequestSchema>;

/** The hint locates only a row. Workload and fresh canonical owner verification precede all operations. */
export const createContinuityDispatcher =
  (dependencies: {
    store: Pick<ContinuityJournalStore, "read">;
    operations: ReturnType<typeof createHostedContinuityOperations>;
    verifyWorkload: (request: Request) => Promise<void>;
    bindWorkload: (
      context: HostedOperatorContext,
      token: () => string,
      signal: AbortSignal,
    ) => void;
    authorize: ProtectedHostedOperatorDependencies["authorize"];
    authorizeRead: (
      request: Request,
      context: HostedOperatorContext,
    ) => Promise<HostedOperatorContext>;
  }) =>
  async (request: Request, parsed: ContinuityTransportRequest) => {
    let stage: ContinuityPlanningStage = "dispatcher_workload_verification";
    try {
      const workloadCarrier = request.headers.get("authorization");
      const frozenWorkloadRequest = new Request(request.url, {
        headers: new Headers(request.headers),
      });
      await dependencies.verifyWorkload(frozenWorkloadRequest);
      let selected: z.infer<typeof operatorSelectionSchema>;
      let savedContext: HostedOperatorContext | undefined;
      if (parsed.action === "continuity-plan") {
        selected = parsed.selection;
      } else {
        const intentId =
          parsed.action === "continuity-status"
            ? parsed.intentId
            : z.uuid().parse(parsed.planRef.split("/").at(-1));
        const saved = await dependencies.store.read({
          authority: parsed.ownerContext.authority,
          intentId,
        });
        if (saved === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        selected = { ...saved.plan.target, environment: "preview" };
        savedContext = {
          authority: saved.plan.authority,
          target: saved.plan.target,
          ownerContext: parsed.ownerContext,
        };
      }
      stage = "dispatcher_owner_authorization";
      const context =
        (parsed.action === "continuity-status" || parsed.action === "continuity-approval") &&
        savedContext !== undefined
          ? await dependencies.authorizeRead(frozenWorkloadRequest, savedContext)
          : await dependencies.authorize(frozenWorkloadRequest, selected, parsed.ownerContext);
      if (workloadCarrier === null || !workloadCarrier.startsWith("Bearer ")) {
        throw new HostedOperatorError("authorization_required");
      }
      dependencies.bindWorkload(context, () => workloadCarrier.slice(7), request.signal);
      stage = "dispatcher_planning";
      const { operations } = dependencies;
      let result;
      switch (parsed.action) {
        case "continuity-plan": {
          result = await operations.plan(context, parsed.runtime, parsed.idempotencyKey);
          break;
        }
        case "continuity-status": {
          result = await operations.status(context, parsed.intentId);
          break;
        }
        case "continuity-approval": {
          result = await operations.approval(context, {
            action: "continuity",
            planRef: parsed.planRef,
            planDigest: parsed.planDigest,
            idempotencyKey: parsed.idempotencyKey,
          });
          break;
        }
        case "continuity": {
          result = await operations.execute(
            context,
            {
              action: "continuity",
              planRef: parsed.planRef,
              planDigest: parsed.planDigest,
              idempotencyKey: parsed.idempotencyKey,
            },
            parsed.callId,
            request.signal,
          );
          break;
        }
        default: {
          throw new HostedOperatorError("resource_mismatch");
        }
      }
      return Response.json(result, { headers: { "cache-control": "private, no-store" } });
    } catch (error) {
      try {
        if (parsed.action === "continuity-plan") {
          reportContinuityPlanningFailure(parsed.selection.sessionId, stage, error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      throw error;
    }
  };
