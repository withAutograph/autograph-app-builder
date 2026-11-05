import { isDeepStrictEqual } from "node:util";
import {
  HostedOperatorError,
  retainedOperatorAuthSchema,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import type {
  readActiveAppInstallationCustomerIds,
  OperatorAppMetadataScope,
} from "./hosted-operator-app-readiness";
import type { readHostedOperatorResourceBindings } from "./hosted-operator-resource-credentials";

/** Retained installation metadata is planning data; a new app proposal cannot authorize its credential read. */
export const createAppInstallationPlanningResourceReader =
  (ports: {
    assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
    store: Pick<ProtectedHostedOperatorDependencies["store"], "read">;
    readResourceBindings: (
      input: HostedOperatorContext & {
        plan: HostedOperatorPlan;
        purpose: "planning";
        privateState?: Parameters<
          typeof readHostedOperatorResourceBindings
        >[0]["record"]["privateState"];
      },
    ) => Promise<ReturnType<typeof readHostedOperatorResourceBindings>>;
    readActiveCustomers: typeof readActiveAppInstallationCustomerIds;
  }) =>
  async (
    context: HostedOperatorContext,
    desired: HostedOperatorPlan,
    scopes: readonly OperatorAppMetadataScope[],
  ) => {
    await ports.assertPlanningAuthorized(context);
    const row = await ports.store.read(context);
    const current = row?.record.operator;
    if (row === undefined || current === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const retained = retainedOperatorAuthSchema.safeParse(row.record.retainedAuth);
    const plan =
      current.plan.stage === "app" && current.approvalId === undefined && retained.success
        ? retained.data.plan
        : current.plan;
    const sameResources = [current.plan, plan].every((selected) =>
      [
        sameOperatorSelection(selected.selection, desired.selection),
        isDeepStrictEqual(selected.appDatabase, desired.appDatabase),
        selected.neon.projectId === desired.neon.projectId,
        selected.neon.branchId === desired.neon.branchId,
        selected.neon.endpoint === desired.neon.endpoint,
      ].every(Boolean),
    );
    if (!sameResources) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const bindingInput = structuredClone({
      ...context,
      purpose: "planning" as const,
      plan,
      privateState: row.record.privateState,
    });
    const bindings = await ports.readResourceBindings(bindingInput);
    return await ports.readActiveCustomers({
      plan: desired,
      scopes,
      runtimeUrl: bindings.appDatabase.runtimeUrl,
      assertCurrent: async () => {
        await ports.assertPlanningAuthorized(context);
        await ports.readResourceBindings(bindingInput);
        const latest = await ports.store.read(context);
        if (
          latest?.revision !== row.revision ||
          !isDeepStrictEqual(latest.record.privateState, row.record.privateState)
        ) {
          throw new HostedOperatorError("operation_in_progress");
        }
      },
    });
  };
