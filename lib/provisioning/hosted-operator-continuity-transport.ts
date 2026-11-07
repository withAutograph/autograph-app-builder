import { reportContinuityPlanningFailure } from "./hosted-operator-consent-diagnostic";
import type { ContinuityPlanningStage } from "./hosted-operator-consent-diagnostic";
import { z } from "zod";
import { verifiedActorReadbackSchema } from "./hosted-operator-verified-actor-contract";
import type { z as Zod } from "zod";
import { appTenantBindingReadbackSchema } from "./hosted-operator-tenant-binding-contract";
import type { AppTenantBindingReadback } from "./hosted-operator-tenant-binding-contract";
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

const continuityReadAction = "continuity-read";
const continuityApprovalAction = "continuity-approval";
const continuityPlanAction = "continuity-plan";
const continuityStatusAction = "continuity-status";

export const continuityTransportRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("continuity-verified-actors"),
    intentId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal("continuity-checkpoints"),
    intentId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal("continuity-binding-read"),
    intentId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal(continuityReadAction),
    intentId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    ...hostedContinuityRequestSchema.shape,
    action: z.literal(continuityApprovalAction),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal(continuityPlanAction),
    idempotencyKey: z.string().min(1),
    ownerContext: operatorOwnerContextSchema,
    predecessorIntentId: z.uuid().optional(),
    runtime: continuityRuntimeSelectionSchema,
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal(continuityStatusAction),
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

/** Keep a failed owner-scoped journal read distinct from an unknown execution outcome. */
const readCanonicalContinuity = async <T>(read: () => Promise<T>, signal: AbortSignal) => {
  try {
    return await read();
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    if (error instanceof HostedOperatorError && error.recoveryStage !== undefined) {
      throw error;
    }
    throw new HostedOperatorError(
      error instanceof HostedOperatorError ? error.code : "operator_unavailable",
      {
        cause: error,
        recoveryStage: "canonical_read",
        ...(error instanceof HostedOperatorError && error.recoveryProgressAdvanced !== undefined
          ? { recoveryProgressAdvanced: error.recoveryProgressAdvanced }
          : {}),
      },
    );
  }
};

/** The hint locates only a row. Workload and fresh canonical owner verification precede all operations. */
export const createContinuityDispatcher =
  (dependencies: {
    store: Pick<ContinuityJournalStore, "read">;
    operations: ReturnType<typeof createHostedContinuityOperations>;
    readVerifiedActors?: (
      context: HostedOperatorContext,
      intentId: string,
    ) => Promise<Zod.infer<typeof verifiedActorReadbackSchema>>;
    readTenantBindings?: (
      context: HostedOperatorContext,
      intentId: string,
    ) => Promise<AppTenantBindingReadback>;
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
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Preserve canonical owner routing for each read and execution action.
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
      if (parsed.action === continuityPlanAction) {
        selected = parsed.selection;
      } else {
        const intentId =
          "intentId" in parsed ? parsed.intentId : z.uuid().parse(parsed.planRef.split("/").at(-1));
        const readSaved = () =>
          dependencies.store.read({ authority: parsed.ownerContext.authority, intentId });
        const saved =
          "intentId" in parsed && parsed.action !== continuityStatusAction
            ? await readCanonicalContinuity(readSaved, request.signal)
            : await readSaved();
        if (saved === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        selected = { ...saved.plan.target, environment: "preview" };
        savedContext = {
          authority: saved.plan.authority,
          ownerContext: parsed.ownerContext,
          target: saved.plan.target,
        };
      }
      stage = "dispatcher_owner_authorization";
      const artifactRead = [
        continuityStatusAction,
        continuityReadAction,
        "continuity-binding-read",
        "continuity-checkpoints",
        "continuity-verified-actors",
        continuityApprovalAction,
      ].includes(parsed.action);
      const context =
        artifactRead && savedContext !== undefined
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
        case continuityPlanAction: {
          result = await operations.plan(
            context,
            parsed.runtime,
            parsed.idempotencyKey,
            parsed.predecessorIntentId === undefined
              ? undefined
              : { predecessorIntentId: parsed.predecessorIntentId },
          );
          break;
        }
        case "continuity-verified-actors": {
          if (dependencies.readVerifiedActors === undefined) {
            throw new HostedOperatorError("protected_operator_required");
          }
          result = verifiedActorReadbackSchema.parse(
            await dependencies.readVerifiedActors(context, parsed.intentId),
          );
          break;
        }
        case "continuity-checkpoints": {
          result = await operations.checkpoints(context, parsed.intentId);
          break;
        }
        case "continuity-binding-read": {
          if (dependencies.readTenantBindings === undefined) {
            throw new HostedOperatorError("protected_operator_required");
          }
          result = appTenantBindingReadbackSchema.parse(
            await dependencies.readTenantBindings(context, parsed.intentId),
          );
          break;
        }
        case continuityReadAction: {
          result = await operations.readPlan(context, parsed.intentId);
          break;
        }
        case continuityStatusAction: {
          result = await operations.status(context, parsed.intentId);
          break;
        }
        case continuityApprovalAction: {
          result = await operations.approval(context, {
            action: "continuity",
            idempotencyKey: parsed.idempotencyKey,
            planDigest: parsed.planDigest,
            planRef: parsed.planRef,
          });
          break;
        }
        case "continuity": {
          result = await operations.execute(
            context,
            {
              action: "continuity",
              idempotencyKey: parsed.idempotencyKey,
              planDigest: parsed.planDigest,
              planRef: parsed.planRef,
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
        if (parsed.action === continuityPlanAction) {
          reportContinuityPlanningFailure(parsed.selection.sessionId, stage, error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      throw error;
    }
  };
