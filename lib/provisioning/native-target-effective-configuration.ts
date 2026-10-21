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
}): Promise<HostedOperatorSourceConfiguration> => {
  const configuration = structuredClone(input.configuration);
  const ready = await input.readReady(input.invocation, input.appId);
  if (ready === undefined) {
    return freezeConfiguration(configuration);
  }

  const { plan, registration } = ready;
  const observed = registration.observed;
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
  configuration.applications[input.appId] = {
    ...(sameTarget ? existing : {}),
    nativeTargetRegistration: true,
    accessRoles: structuredClone(plan.productRoles),
    appDatabase: structuredClone(plan.appDatabase),
    branch: plan.branch,
    projectId: observed.projectId,
    projectSettings: structuredClone(observed.projectSettings),
  };
  configuration.sandbox.workers[input.appId] = structuredClone(plan.worker);
  configuration.catalogAppIds = [...new Set([...configuration.catalogAppIds, input.appId])];
  configuration.gateway.protectedApplicationIds = [
    ...new Set([...configuration.gateway.protectedApplicationIds, input.appId]),
  ];
  // Shared Auth/Neon custody remains the deployment's approved configuration. A target
  // registration supplies app resource names, never replacement grants or credentials.
  return freezeConfiguration(configuration);
};
