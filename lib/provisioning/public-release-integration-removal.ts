import { isDeepStrictEqual } from "node:util";
import type {
  AppIntegrationReleaseAttachment,
  AppIntegrationRemoval,
} from "./app-integration-release-contract";
import { appIntegrationRemovalSchema } from "./app-integration-release-contract";
import type { PublicReleaseEffectContext, PublicReleaseInvocation } from "./public-release-handler";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";

export interface PublicReleaseIntegrationRemovalEffectContext extends PublicReleaseEffectContext {
  /** Recheck Builder owner/consent/journal/physical lease only; no target SQL under worker locks. */
  assertCurrent: () => Promise<void>;
}
/** Trusted native composition only: no operator impersonation of the human Disable action. */
export interface PublicReleaseIntegrationRemovalPorts {
  readPreflight: (input: {
    invocation: PublicReleaseInvocation;
    sourceCapability: AppIntegrationReleaseAttachment;
    /** On retry, re-observe the original immutable stop snapshot and this operation's own durable inactive fence. */
    expected?: { removal: AppIntegrationRemoval; operationRef: string };
    assertCurrent: () => Promise<void>;
  }) => Promise<AppIntegrationRemoval>;
  /** Read the durable fence for this exact approved operation. Pending uncertainty cannot authorize another write. */
  reconcile: (
    context: PublicReleaseIntegrationRemovalEffectContext,
  ) => Promise<"applied" | "not-applied" | "unknown">;
  /** Recheck stopped bindings and revoke only this app's authority under the existing ordered installer locks. */
  apply: (context: PublicReleaseIntegrationRemovalEffectContext) => Promise<void>;
}
export const requireIntegrationRemovalPorts = (
  ports: PublicReleaseIntegrationRemovalPorts | undefined,
) => {
  if (ports === undefined) {
    throw new PublicReleasePrerequisiteError("public_release_integration_removal_required");
  }
  return ports;
};
export const readPublicReleaseIntegrationRemoval = async (input: {
  ports: PublicReleaseIntegrationRemovalPorts | undefined;
  invocation: PublicReleaseInvocation;
  sourceCapability: AppIntegrationReleaseAttachment;
  expected?: { removal: AppIntegrationRemoval; operationRef: string };
  assertCurrent: () => Promise<void>;
}) => {
  const ports = requireIntegrationRemovalPorts(input.ports);
  await input.assertCurrent();
  const observed = appIntegrationRemovalSchema.parse(
    await ports.readPreflight({
      invocation: input.invocation,
      sourceCapability: input.sourceCapability,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      assertCurrent: input.assertCurrent,
    }),
  );
  await input.assertCurrent();
  const source = input.sourceCapability;
  const matches = [
    input.expected === undefined || isDeepStrictEqual(input.expected.removal, observed),
    isDeepStrictEqual(observed.sourceCapability, {
      operationRef: source.operationRef,
      planDigest: source.planDigest,
    }),
    observed.scopeSha256 === source.scopeSha256,
    observed.authority.principalGeneration === source.capability.control.principalGeneration,
    observed.authority.principalName === source.capability.control.database.runtimeRole,
    observed.authority.configurationRef === source.capability.privateConfiguration.reference,
    observed.authority.configurationSha256 === source.capability.privateConfiguration.sha256,
  ];
  if (matches.includes(false)) {
    throw new PublicReleasePrerequisiteError("public_release_integration_removal_required");
  }
  return observed;
};
