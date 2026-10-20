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

export const tenantExportTransportRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...hostedTenantExportRequestSchema.shape,
    action: z.literal("export-approval"),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal("export-plan"),
    selection: operatorSelectionSchema,
    customerId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    ownerContext: operatorOwnerContextSchema,
  }),
  z.strictObject({
    action: z.literal("export-status"),
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

/** The hint locates only a row. Workload and fresh canonical owner verification precede all operations. */
export const createTenantExportDispatcher =
  (dependencies: {
    store: Pick<TenantExportJournalStore, "read">;
    operations: ReturnType<typeof createHostedTenantExportOperations>;
    verifyWorkload: (request: Request) => Promise<void>;
    authorize: ProtectedHostedOperatorDependencies["authorize"];
    authorizeRead: (
      request: Request,
      context: HostedOperatorContext,
    ) => Promise<HostedOperatorContext>;
  }) =>
  async (request: Request, parsed: TenantExportTransportRequest) => {
    await dependencies.verifyWorkload(request);
    let selected: z.infer<typeof operatorSelectionSchema>;
    let savedContext: HostedOperatorContext | undefined;
    if (parsed.action === "export-plan") {
      selected = parsed.selection;
    } else {
      const exportId =
        parsed.action === "export-status"
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
        target: saved.originalTarget,
        ownerContext: parsed.ownerContext,
      };
    }
    const context =
      (parsed.action === "export-status" || parsed.action === "export-approval") &&
      savedContext !== undefined
        ? await dependencies.authorizeRead(request, savedContext)
        : await dependencies.authorize(request, selected, parsed.ownerContext);
    const { operations } = dependencies;
    let result;
    switch (parsed.action) {
      case "export-plan": {
        result = await operations.plan(context, parsed.customerId, parsed.idempotencyKey);
        break;
      }
      case "export-status": {
        result = await operations.status(context, parsed.exportId);
        break;
      }
      case "export-approval": {
        result = await operations.approval(context, {
          action: "export",
          planRef: parsed.planRef,
          planDigest: parsed.planDigest,
          idempotencyKey: parsed.idempotencyKey,
        });
        break;
      }
      case "export": {
        result = await operations.execute(
          context,
          {
            action: "export",
            planRef: parsed.planRef,
            planDigest: parsed.planDigest,
            idempotencyKey: parsed.idempotencyKey,
          },
          parsed.callId,
        );
        break;
      }
      default: {
        throw new HostedOperatorError("resource_mismatch");
      }
    }
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  };
