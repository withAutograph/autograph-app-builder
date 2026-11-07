import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { HostedOperatorError, operatorOwnerContextSchema } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import type {
  createNativeTargetAuthOnlyOwnerLink,
  NativeTargetAuthOnlyOwnerLinkBinding,
} from "./native-target-auth-only-owner-link";

type OwnerLink = ReturnType<typeof createNativeTargetAuthOnlyOwnerLink>;
type Pending = NonNullable<Awaited<ReturnType<OwnerLink["readPending"]>>>;
type Selector = Parameters<OwnerLink["readPending"]>[0];
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export interface NativeTargetAuthOnlyRealmCallbackPorts {
  ownerLink: Pick<OwnerLink, "readPending" | "consume">;
  /** Must independently re-read canonical ownership, settled approvals, native READY deployment and live Auth catalog. */
  readReadyBinding: (binding: NativeTargetAuthOnlyOwnerLinkBinding) => Promise<
    | {
        context: HostedOperatorContext;
        configuration: HostedOperatorSourceConfiguration;
        gateway: NativeTargetAuthOnlyOwnerLinkBinding["gateway"];
        readiness: {
          authOnlyPlanDigest: string;
          resourcePlanDigest: string;
          gatewayDeliveryPlanDigest: string;
          authResourceId: string;
          catalogFingerprint: string;
        };
      }
    | undefined
  >;
  /** Resume only the saved operation after its owner-link journal reports consumption. */
  afterLinked?: (
    context: HostedOperatorContext,
    binding: NativeTargetAuthOnlyOwnerLinkBinding,
    proof: { nonceSha256: string; proofRef: string; proofSha256: string },
  ) => Promise<void>;
}

const denied = () => new HostedOperatorError("auth_identity_required");

export const selectNativeTargetAuthOnlyRealmCallback = async (
  ports: NativeTargetAuthOnlyRealmCallbackPorts,
  selector: Selector,
  builderOrigin: string,
) => {
  const pending = await ports.ownerLink.readPending(selector);
  // A lookup miss allows the established legacy lookup. A matched invalid record always fails closed.
  if (pending === undefined) {
    return undefined;
  }
  const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse(pending.binding);
  if (
    selector.ownerSessionId !== binding.target.sessionId ||
    selector.nonceSha256 !== pending.link.nonceSha256 ||
    (selector.authority !== undefined && !isDeepStrictEqual(selector.authority, binding.authority))
  ) {
    throw denied();
  }
  const ready = await ports.readReadyBinding(binding);
  if (ready === undefined) {
    throw denied();
  }
  const { context, configuration, readiness } = ready;
  const owner = operatorOwnerContextSchema.parse(context.ownerContext);
  const { scope } = configuration.nativeNeon;
  const resource = binding.bootstrapResource;
  if (
    !isDeepStrictEqual(context.authority, binding.authority) ||
    !isDeepStrictEqual(context.target, binding.target) ||
    !isDeepStrictEqual(owner.authority, binding.authority) ||
    owner.sessionId !== binding.target.sessionId ||
    configuration.builderCallbackOrigin !== builderOrigin ||
    configuration.teamId !== binding.target.scopeId ||
    configuration.operator.origin !== binding.audience ||
    configuration.operator.environment !== "preview" ||
    configuration.gateway.environment !== "preview" ||
    configuration.gateway.projectId !== binding.gateway.projectId ||
    configuration.gateway.branch !== binding.gateway.branch ||
    configuration.gateway.authBrowserOrigin !== binding.browserOrigin ||
    configuration.gateway.publicOrigin !== binding.issuer ||
    !isDeepStrictEqual(configuration.gateway.workload, binding.sender) ||
    !isDeepStrictEqual(ready.gateway, binding.gateway) ||
    configuration.authDatabase.resourceId !== binding.authResourceId ||
    configuration.authDatabase.database !== resource.database ||
    configuration.authDatabase.migratorRole !== resource.migratorRole ||
    configuration.authDatabase.runtimeRole !== resource.runtimeRole ||
    scope.hostname !== resource.hostname ||
    scope.projectId !== resource.neon.projectId ||
    scope.branchId !== resource.neon.branchId ||
    !isDeepStrictEqual(pending.bootstrapResource, resource) ||
    !isDeepStrictEqual(pending.sender, binding.sender) ||
    pending.link.ownerSessionId !== binding.target.sessionId ||
    pending.link.authResourceId !== binding.authResourceId ||
    pending.link.bootstrapPlanDigest !== binding.resourcePlanDigest ||
    pending.link.endpointOrigin !== binding.gateway.origin ||
    pending.link.browserOrigin !== binding.browserOrigin ||
    pending.link.issuer !== binding.issuer ||
    pending.link.audience !== binding.audience ||
    pending.link.organizationId !== null ||
    pending.jwksUrl !== new URL("/_platform/jwks.json", binding.gateway.origin).href ||
    readiness.authOnlyPlanDigest !== binding.authOnlyPlanDigest ||
    readiness.resourcePlanDigest !== binding.resourcePlanDigest ||
    readiness.gatewayDeliveryPlanDigest !== binding.gatewayDeliveryPlanDigest ||
    readiness.authResourceId !== binding.authResourceId ||
    !digest.safeParse(readiness.catalogFingerprint).success
  ) {
    throw denied();
  }
  return {
    binding,
    configuration,
    context,
    staging: {
      link: pending.link,
      bootstrapResource: pending.bootstrapResource,
      jwksUrl: pending.jwksUrl,
    } satisfies Pick<Pending, "link" | "bootstrapResource" | "jwksUrl">,
  };
};
