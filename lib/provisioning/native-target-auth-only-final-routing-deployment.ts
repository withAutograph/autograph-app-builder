import { isDeepStrictEqual } from "node:util";
import type {
  createPostgresPhysicalResourceLease,
  PhysicalResourceFence,
} from "./postgres-physical-resource-lease";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { buildNativeTargetAuthOnlyFinalRoutingPlanBytes } from "./native-target-auth-only-final-routing";
import type { createNativeTargetAuthOnlyFinalRouting } from "./native-target-auth-only-final-routing";
import type { NativeTargetAuthOnlyDeliveryEnvironmentInput } from "./native-target-auth-only-delivery-runtime";
import type { createNativeTargetAuthOnlyPreviewEnvironmentAdapter } from "./native-target-auth-only-preview-environment-adapter";

type PrepareInput = Parameters<typeof buildNativeTargetAuthOnlyFinalRoutingPlanBytes>[0];
type PhysicalLease = ReturnType<typeof createPostgresPhysicalResourceLease>;
export interface NativeTargetAuthOnlyFinalRoutingAuthority {
  preparePlan: (input: {
    environment: NativeTargetAuthOnlyDeliveryEnvironmentInput;
    gateway: PrepareInput["bootstrap"];
    app: PrepareInput["app"];
    routingOperationRef: string;
  }) => Promise<Buffer>;
  assertCatalogApp: Parameters<
    typeof createNativeTargetAuthOnlyFinalRouting
  >[0]["assertCatalogApp"];
  withGatewayLease: <T>(
    input: {
      environment: NativeTargetAuthOnlyDeliveryEnvironmentInput;
      readCurrentFence: () => Promise<PhysicalResourceFence>;
    },
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
}

/** Bind final routing to the same deployment-owned profile and physical Gateway lock used by normal setup. */
export const createNativeTargetAuthOnlyFinalRoutingAuthority = (input: {
  readConfiguration: (
    environment: NativeTargetAuthOnlyDeliveryEnvironmentInput,
  ) => Promise<Pick<HostedOperatorSourceConfiguration, "catalogAppIds" | "gateway"> | undefined>;
  openProjection: ReturnType<
    typeof createNativeTargetAuthOnlyPreviewEnvironmentAdapter
  >["openGatewayProjection"];
  withPhysicalLease: PhysicalLease;
}): NativeTargetAuthOnlyFinalRoutingAuthority => {
  const readSource = async (environment: NativeTargetAuthOnlyDeliveryEnvironmentInput) => {
    await environment.assertCurrent();
    const selected = await input.readConfiguration(environment);
    const gateway = environment.deliveryPlan.delivery.gatewayDelivery;
    if (selected === undefined) {
      throw new HostedOperatorError("operator_unavailable");
    }
    const exactSource =
      gateway !== undefined &&
      [
        gateway.projectId === selected.gateway.projectId,
        gateway.branch === selected.gateway.branch,
        gateway.gitSha === selected.gateway.gitSha,
        gateway.repoId === selected.gateway.repoId,
        environment.deliveryPlan.delivery.publicGateway?.origin === selected.gateway.publicOrigin,
        selected.catalogAppIds.includes(environment.target.appId),
        selected.gateway.protectedApplicationIds.includes(environment.target.appId),
      ].every(Boolean);
    if (!exactSource) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const source = { ...selected.gateway.workload, publicOrigin: selected.gateway.publicOrigin };
    if (
      source.environment !== "preview" ||
      source.ownerId !== environment.target.scopeId ||
      source.projectId !== selected.gateway.projectId
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    await environment.assertCurrent();
    return source;
  };
  return {
    async preparePlan(value) {
      const source = await readSource(value.environment);
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Verify the exact registered source before opening the owned provider row.
      const projection = await input.openProjection(value.environment);
      const row = await projection.read();
      await value.environment.assertCurrent();
      return buildNativeTargetAuthOnlyFinalRoutingPlanBytes({
        operationRef: value.routingOperationRef,
        environment: value.environment,
        bootstrap: value.gateway,
        app: value.app,
        source: { ...source, environment: "preview" },
        projectionRow: row,
      });
    },
    async assertCatalogApp(value) {
      if (!isDeepStrictEqual(await readSource(value.environment), value.source)) {
        throw new HostedOperatorError("resource_mismatch");
      }
    },
    async withGatewayLease(value, run) {
      const source = await readSource(value.environment);
      return await input.withPhysicalLease(
        {
          lockKeys: [
            JSON.stringify([
              "hosted_protected_operator_vercel_project_v1",
              source.ownerId,
              source.projectId,
            ]),
          ],
          readCurrentFence: value.readCurrentFence,
        },
        run,
      );
    },
  };
};
