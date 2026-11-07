import { isDeepStrictEqual } from "node:util";
import { nativeTargetResourceProfileAuthorityDigest } from "./native-target-resource-profile";
import { hasSingleProjectServicesTopology } from "./hosted-operator-source-configuration-schema";

import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { NativeTargetReadyRegistration } from "./native-target-onboarding-contract";

/** The registry port reauthorizes current canonical ownership before its private read. */
export type ReadReadyNativeTarget<Invocation> = (
  invocation: Invocation,
  appId: string,
) => Promise<NativeTargetReadyRegistration | undefined>;

const freezeConfiguration = <Value>(value: Value): Value => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Recursive freezing traverses an already typed private configuration, not untrusted input.
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeConfiguration(child);
    }
    Object.freeze(value);
  }
  return value;
};

/**
 * One operation gets one private configuration snapshot. Only its authorized app is projected;
 * other registrations do not change a retained plan's catalog or resource selection.
 */
export const resolveNativeTargetEffectiveConfiguration = async <Invocation>(input: {
  configuration: HostedOperatorSourceConfiguration;
  invocation: Invocation;
  appId: string;
  readReady: ReadReadyNativeTarget<Invocation>;
  selectResourceConfiguration?: (
    ready: NativeTargetReadyRegistration,
  ) => HostedOperatorSourceConfiguration;
}): Promise<HostedOperatorSourceConfiguration> => {
  const ready = await input.readReady(input.invocation, input.appId);
  if (input.configuration.composition === "single-project-services") {
    // readReady above still reauthorizes the current canonical owner. A historical
    // dedicated-project registration must not redirect this explicit destination.
    if (
      input.configuration.applications[input.appId] === undefined ||
      !hasSingleProjectServicesTopology(input.configuration)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return freezeConfiguration(structuredClone(input.configuration));
  }
  if (input.configuration.composition === "single-project-services") {
    // readReady above still reauthorizes the current canonical owner. A historical
    // dedicated-project registration must not redirect this explicit destination.
    if (
      input.configuration.applications[input.appId] === undefined ||
      !hasSingleProjectServicesTopology(input.configuration)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return freezeConfiguration(structuredClone(input.configuration));
  }
  if (ready === undefined) {
    return freezeConfiguration(structuredClone(input.configuration));
  }

  const { plan, registration } = ready;
  if (plan.resourceProfileId !== undefined && input.selectResourceConfiguration === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const configuration = structuredClone(
    input.selectResourceConfiguration?.(ready) ?? input.configuration,
  );
  if (
    plan.resourceProfileId !== undefined &&
    ![
      plan.resourceProfileAuthorityDigest ===
        nativeTargetResourceProfileAuthorityDigest(configuration),
      isDeepStrictEqual(plan.nativeNeon.scope, configuration.nativeNeon.scope),
      isDeepStrictEqual(
        plan.nativeNeon.nativeStore,
        configuration.nativeNeon.configuration.nativeStore,
      ),
      plan.appDatabase.resourceId === configuration.nativeNeon.configuration.nativeStore.resourceId,
    ].every(Boolean)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const { observed } = registration;
  const targetMatches = [
    ready.appId === input.appId,
    plan.appId === input.appId,
    observed.teamId === configuration.teamId,
    observed.projectId !== configuration.gateway.projectId,
    observed.projectId !== configuration.operator.projectId,
  ].every(Boolean);
  if (!targetMatches) {
    throw new HostedOperatorError("resource_mismatch");
  }

  const existing = configuration.applications[input.appId];
  // Retain optional static publication/policy metadata only for the same actual target.
  const sameTarget = existing?.projectId === observed.projectId && existing.branch === plan.branch;
  const retainedConfiguration = sameTarget ? existing : undefined;
  configuration.applications[input.appId] = {
    ...retainedConfiguration,
    accessRoles: structuredClone(plan.productRoles),
    appDatabase: structuredClone(plan.appDatabase),
    branch: plan.branch,
    nativeTargetRegistration: true,
    projectId: observed.projectId,
    projectSettings: structuredClone(observed.projectSettings),
  };
  configuration.sandbox.workers[input.appId] = structuredClone(plan.worker);
  configuration.catalogAppIds = [...new Set([...configuration.catalogAppIds, input.appId])];
  configuration.gateway.protectedApplicationIds = [
    ...new Set([...configuration.gateway.protectedApplicationIds, input.appId]),
  ];
  // Auth/Neon/Gateway custody comes from the exact deployment-approved owner/app
  // profile (or the legacy base). A registration never supplies credentials or grants.
  return freezeConfiguration(configuration);
};
