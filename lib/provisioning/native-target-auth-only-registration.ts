import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { NativeTargetAuthOnlyDispatchStore } from "./native-target-auth-only-dispatch";
import { nativeTargetAuthOnlyAuthorityDigest } from "./native-target-auth-only-planner";
import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";

/** Projects only a verified Auth-only target; it deliberately adds no application database. */
export const resolveNativeTargetAuthOnlyRegistration = async (input: {
  configuration: HostedOperatorSourceConfiguration;
  store: Pick<NativeTargetAuthOnlyDispatchStore, "read">;
  authority: OperatorOwnerContext["authority"];
  sessionId: string;
  appId: string;
  environment: Readonly<Record<string, string | undefined>>;
}) => {
  const policy = input.configuration.authOnlyApplications?.[input.appId];
  if (policy === undefined || input.configuration.applications[input.appId] !== undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const row = await input.store.read({ appId: input.appId, authority: input.authority });
  if (row?.state.stage !== "created") {
    const registration = undefined;
    return registration;
  }
  const { plan, projectId } = row.state;
  if (
    plan.appId !== input.appId ||
    plan.origin.publicSessionId !== input.sessionId ||
    !isDeepStrictEqual(plan.origin.authority, input.authority) ||
    !policy.accessRoles.includes(plan.appRole)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  let selected: HostedOperatorSourceConfiguration;
  try {
    selected = resolveNativeTargetResourceProfile({
      appId: input.appId,
      authority: input.authority,
      base: input.configuration,
      environment: input.environment,
      resourceProfileId: plan.authResource.profileId,
    });
  } catch {
    throw new HostedOperatorError("resource_mismatch");
  }
  const roles = selected.authOnlyApplications?.[input.appId]?.accessRoles;
  if (roles === undefined || !roles.includes(plan.appRole)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const binding = {
    authDatabase: selected.authDatabase,
    gateway: {
      authBrowserOrigin: selected.gateway.authBrowserOrigin,
      branch: selected.gateway.branch,
      environment: selected.gateway.environment,
      gatewayOrigin: selected.gateway.gatewayOrigin,
      projectId: selected.gateway.projectId,
      publicOrigin: selected.gateway.publicOrigin,
      workload: selected.gateway.workload,
    },
    nativeNeon: selected.nativeNeon,
    operator: {
      environment: selected.operator.environment,
      origin: selected.operator.origin,
      projectId: selected.operator.projectId,
    },
  };
  const authorityDigest = nativeTargetAuthOnlyAuthorityDigest({
    appId: input.appId,
    authDatabase: selected.authDatabase,
    authority: input.authority,
    authorityBinding: binding,
    physicalEndpointId: selected.nativeNeon.scope.endpointId,
    profileId: plan.authResource.profileId,
    roles,
  });
  if (
    !isDeepStrictEqual(
      {
        resourceId: selected.authDatabase.resourceId,
        database: selected.authDatabase.database,
        endpointId: selected.nativeNeon.scope.endpointId,
        hostname: selected.nativeNeon.scope.hostname,
        authorityDigest,
      },
      {
        resourceId: plan.authResource.resourceId,
        database: plan.authResource.database,
        endpointId: plan.authResource.endpointId,
        hostname: plan.authResource.hostname,
        authorityDigest: plan.authResource.authorityDigest,
      },
    )
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  // Return the selected owner/app profile so downstream Auth runtime setup cannot
  // fall back to base/shared Auth custody.
  const effective = structuredClone(selected);
  const application = effective.authOnlyApplications?.[input.appId];
  if (application === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  application.registration = {
    appRole: plan.appRole,
    authResource: structuredClone(plan.authResource),
    branch: plan.branch,
    ownerUserId: input.authority.ownerUserId,
    planDigest: row.state.planDigest,
    projectId,
    projectSettings: structuredClone(plan.project.projectSettings),
    sessionId: input.sessionId,
  };
  return effective;
};
