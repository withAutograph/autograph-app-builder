import { reportExportPlanningFailure } from "./hosted-operator-consent-diagnostic";
import type {
  ExportPlanningStage,
  ExportPlanningStageObserver,
} from "./hosted-operator-consent-diagnostic";
import { z } from "zod";
import {
  operatorOwnerContextSchema,
  operatorSelectionSchema,
  HostedOperatorError,
} from "./hosted-operator-contract";
import {
  hostedTenantExportRequestSchema,
  hostedTenantExportPlanSchema,
  tenantExportStatusSchema,
} from "./hosted-operator-export-contract";
import type {
  createHostedTenantExportOperations,
  TenantExportJournalStore,
} from "./hosted-operator-export";
import type {
  ProtectedHostedOperatorDependencies,
  HostedOperatorContext,
} from "./hosted-operator-service";

const EXPORT_APPROVAL_ACTION = "export-approval";
const EXPORT_PLAN_ACTION = "export-plan";
const EXPORT_READ_ACTION = "export-read";
const EXPORT_STATUS_ACTION = "export-status";

export const tenantExportTransportRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...hostedTenantExportRequestSchema.shape,
    action: z.literal(EXPORT_APPROVAL_ACTION),
    ownerContext: operatorOwnerContextSchema,
  }),
  z
    .strictObject({
      action: z.literal(EXPORT_PLAN_ACTION),
      customerId: z.string().min(1).optional(),
      customerScope: z.literal("owner-organization").optional(),
      idempotencyKey: z.string().min(1),
      ownerContext: operatorOwnerContextSchema,
      selection: operatorSelectionSchema,
    })
    .refine(
      (input) => (input.customerId === undefined) !== (input.customerScope === undefined),
      "Select one export customer scope.",
    ),
  z.strictObject({
    action: z.literal(EXPORT_READ_ACTION),
    exportId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal(EXPORT_STATUS_ACTION),
    exportId: z.uuid(),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    ...hostedTenantExportRequestSchema.shape,
    callId: z.string().min(1),
    ownerContext: operatorOwnerContextSchema,
  }),
]);
export const tenantExportPlannedSchema = z.strictObject({
  plan: hostedTenantExportPlanSchema,
  request: hostedTenantExportRequestSchema,
  status: tenantExportStatusSchema,
});

export type TenantExportTransportRequest = z.infer<typeof tenantExportTransportRequestSchema>;

const isArtifactReadAction = (action: TenantExportTransportRequest["action"]) =>
  action === EXPORT_STATUS_ACTION ||
  action === EXPORT_READ_ACTION ||
  action === EXPORT_APPROVAL_ACTION;

const verifiedWorkloadToken = (carrier: string | null) => {
  if (carrier === null || !carrier.startsWith("Bearer ")) {
    throw new HostedOperatorError("authorization_required");
  }
  return () => carrier.slice(7);
};

/** The hint locates only a row. Workload and fresh canonical owner verification precede all operations. */
export const createTenantExportDispatcher =
  (dependencies: {
    store: Pick<TenantExportJournalStore, "read">;
    operations: ReturnType<typeof createHostedTenantExportOperations>;
    resolveOwnerOrganization?: (context: HostedOperatorContext) => Promise<string>;
    verifyWorkload: (request: Request) => Promise<void>;
    bindWorkload?: (
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
  async (request: Request, parsed: TenantExportTransportRequest) => {
    let planStage: ExportPlanningStage = "dispatcher_workload_verification";
    const onPlanStage: ExportPlanningStageObserver = (next) => {
      planStage = next;
    };
    try {
      const workloadCarrier = request.headers.get("authorization");
      const frozenWorkloadRequest = new Request(request.url, {
        headers: new Headers(request.headers),
      });
      await dependencies.verifyWorkload(frozenWorkloadRequest);
      let selected: z.infer<typeof operatorSelectionSchema>;
      let savedContext: HostedOperatorContext | undefined;
      if (parsed.action === EXPORT_PLAN_ACTION) {
        selected = parsed.selection;
      } else {
        const exportId =
          parsed.action === EXPORT_STATUS_ACTION || parsed.action === EXPORT_READ_ACTION
            ? parsed.exportId
            : z.uuid().parse(parsed.planRef.split("/").at(-1));
        const saved = await dependencies.store.read({
          authority: parsed.ownerContext.authority,
          exportId,
        });
        if (saved === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        selected = { ...saved.journal.plan.target, environment: "preview" };
        savedContext = {
          authority: saved.journal.authority,
          ownerContext: parsed.ownerContext,
          target: saved.originalTarget,
        };
      }
      planStage = "dispatcher_owner_authorization";
      const context =
        isArtifactReadAction(parsed.action) && savedContext !== undefined
          ? await dependencies.authorizeRead(frozenWorkloadRequest, savedContext)
          : await dependencies.authorize(frozenWorkloadRequest, selected, parsed.ownerContext);
      if (dependencies.bindWorkload !== undefined) {
        dependencies.bindWorkload(context, verifiedWorkloadToken(workloadCarrier), request.signal);
      }
      const { operations } = dependencies;
      let result;
      switch (parsed.action) {
        case EXPORT_PLAN_ACTION: {
          const customerId =
            parsed.customerScope === undefined
              ? z.string().parse(parsed.customerId)
              : await dependencies.resolveOwnerOrganization?.(context);
          if (customerId === undefined) {
            throw new HostedOperatorError("export_customer_selection_required");
          }
          result = await operations.plan(context, customerId, parsed.idempotencyKey, onPlanStage);
          break;
        }
        case EXPORT_READ_ACTION: {
          result = await operations.readPlan(context, parsed.exportId);
          break;
        }
        case EXPORT_STATUS_ACTION: {
          result = await operations.status(context, parsed.exportId);
          break;
        }
        case EXPORT_APPROVAL_ACTION: {
          result = await operations.approval(context, {
            action: "export",
            idempotencyKey: parsed.idempotencyKey,
            planDigest: parsed.planDigest,
            planRef: parsed.planRef,
          });
          break;
        }
        case "export": {
          result = await operations.execute(
            context,
            {
              action: "export",
              idempotencyKey: parsed.idempotencyKey,
              planDigest: parsed.planDigest,
              planRef: parsed.planRef,
            },
            parsed.callId,
          );
          break;
        }
        default: {
          throw new HostedOperatorError("resource_mismatch");
        }
      }
      planStage = "plan_response";
      return Response.json(result, { headers: { "cache-control": "private, no-store" } });
    } catch (error) {
      try {
        if (parsed.action === EXPORT_PLAN_ACTION) {
          reportExportPlanningFailure(parsed.ownerContext.sessionId, planStage, error);
        }
      } catch {
        /* Even an invalid diagnostic context must preserve the original failure. */
      }
      throw error;
    }
  };
