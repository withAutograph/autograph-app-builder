import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import { createNativePreviewNeonPlanningAuthority } from "./hosted-operator-native-preview-authority";
import { createPreviewNeonMcpReader } from "./hosted-operator-native-preview-neon-mcp";
import type { PreviewNeonMcpDependencies } from "./hosted-operator-native-preview-neon-mcp";
import { scopeSchema } from "./hosted-operator-native-preview-neon";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-resource-plan-schema";
import { nativeTargetAuthOnlyCredentialContextForPlan } from "./native-target-auth-only-credential-store";
import { nativeTargetAuthOnlyApprovalSchema } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { resolveNativeTargetResourceProfile } from "./native-target-resource-profile";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("Approved Auth-only maintenance credential is unavailable.");

export { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-resource-plan-schema";

const executionSchema = z.strictObject({
  fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseId: z.uuid(),
  operationRef: z.uuid(),
  workerAttemptId: z.uuid(),
});
export interface AuthOnlyMaintenanceAuthorityBinding {
  context: HostedOperatorContext;
  planDigest: string;
  resourcePlanDigest: string;
  effectId: string;
  resourceId: string;
  execution: z.infer<typeof executionSchema>;
}
type OwnerPorts = Parameters<typeof createNativePreviewNeonPlanningAuthority>[0]["controlPlane"];
type Material = Parameters<
  ReturnType<typeof createPreviewNeonMcpReader>["withMaintenanceCredential"]
>[2] extends (material: infer M) => Promise<unknown>
  ? M
  : never;

/** Private reader only. The caller supplies the actual retained resource approval and live execution authority. */
export const createNativeTargetAuthOnlyMaintenanceReader = (input: {
  context: HostedOperatorContext;
  plan: NativeTargetAuthOnlyPlan;
  configuration: HostedOperatorSourceConfiguration;
  environment: Readonly<Record<string, string | undefined>>;
  approvedResourcePlanBytes: Buffer;
  approval: NativeTargetAuthOnlyApproval;
  execution: z.infer<typeof executionSchema>;
  assertCurrentOwner: (context: HostedOperatorContext) => Promise<void>;
  /** Re-read the real lease, fence and attempt for this exact resource effect; never infer them from approval. */
  assertCurrent: (binding: AuthOnlyMaintenanceAuthorityBinding) => Promise<void>;
  /** Read settled human approval plus the retained source/resource bytes from their private owner-bound storage. */
  readRetainedResourceApproval: (binding: AuthOnlyMaintenanceAuthorityBinding) => Promise<
    | {
        plan: NativeTargetAuthOnlyPlan;
        approvedResourcePlanBytes: Buffer;
        approval: NativeTargetAuthOnlyApproval;
      }
    | undefined
  >;
  readCredential: OwnerPorts["readCredential"];
  fetch?: typeof fetch;
  io?: PreviewNeonMcpDependencies["io"];
  diagnosticSink?: PreviewNeonMcpDependencies["diagnosticSink"];
}) => {
  const context: HostedOperatorContext = {
    authority: structuredClone(input.context.authority),
    ownerContext:
      input.context.ownerContext === undefined
        ? undefined
        : structuredClone(input.context.ownerContext),
    target: hostedRuntimeTargetSchema.parse(input.context.target),
  };
  const plan = nativeTargetAuthOnlyPlanSchema.parse(input.plan);
  const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
  const resourceBytes = Buffer.from(input.approvedResourcePlanBytes);
  const resourcePlanDigest = digest(resourceBytes);
  const resourcePlan = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(
    JSON.parse(resourceBytes.toString("utf-8")),
  );
  const approval = nativeTargetAuthOnlyApprovalSchema.parse(input.approval);
  const execution = executionSchema.parse(input.execution);
  const profileInput = { configuration: input.configuration, environment: input.environment, plan };
  const credentialContext = nativeTargetAuthOnlyCredentialContextForPlan(profileInput);
  const profile = resolveNativeTargetResourceProfile({
    appId: plan.appId,
    authority: plan.origin.authority,
    base: input.configuration,
    environment: input.environment,
    resourceProfileId: plan.authResource.profileId,
  });
  const native = structuredClone(profile.nativeNeon);
  const scope = scopeSchema.parse(native.scope);
  const { resource } = credentialContext;
  const effect = resourcePlan.effects.filter((entry) => entry.kind === "resources");
  if (
    !isDeepStrictEqual(context.authority, plan.origin.authority) ||
    context.target.appId !== plan.appId ||
    context.target.sessionId !== plan.origin.publicSessionId ||
    context.target.branch !== plan.branch ||
    context.target.scopeType !== "team" ||
    context.target.scopeId !== plan.project.teamId ||
    context.target.installationId !== plan.project.installationId ||
    resourcePlan.authOnlyPlanDigest !== planDigest ||
    !isDeepStrictEqual(resourcePlan.target, context.target) ||
    !isDeepStrictEqual(resourcePlan.nativeNeonConfiguration, native.configuration) ||
    !isDeepStrictEqual(resourcePlan.authDatabase, profile.authDatabase) ||
    resourcePlan.neon.projectId !== scope.projectId ||
    resourcePlan.neon.branchId !== scope.branchId ||
    resourcePlan.neon.endpoint !== scope.hostname ||
    resourcePlan.bootstrap.endpointId !== scope.endpointId ||
    resourcePlan.bootstrap.maintenanceDatabase !== scope.maintenanceDatabase ||
    resourcePlan.bootstrap.role !== scope.maintenanceRole ||
    resourcePlan.resourcesInstaller.reference !== "neon-resource-bootstrap-v1" ||
    resourcePlan.resourcesInstaller.reference !== profile.sandbox.resourcesWorker.id ||
    resourcePlan.resourcesInstaller.sha256 !== profile.sandbox.resourcesWorker.sha256 ||
    effect.length !== 1 ||
    effect[0]?.resourceId !== resource.resourceId ||
    resourcePlan.effects.filter((entry) => entry.id === effect[0]?.id).length !== 1 ||
    plan.authResource.resourceId !== resource.resourceId ||
    plan.authResource.database !== resource.database ||
    plan.authResource.hostname !== resource.neon.hostname ||
    plan.authResource.endpointId !== resource.neon.endpointId ||
    approval.outcome !== "approved" ||
    approval.planDigest !== planDigest ||
    approval.sourceDigest !== resourcePlanDigest ||
    approval.publicSessionId !== plan.origin.publicSessionId ||
    approval.responderPrincipalId !== plan.origin.authority.ownerUserId
  ) {
    throw unavailable();
  }

  const binding = {
    context,
    effectId: effect[0]!.id,
    execution,
    planDigest,
    resourceId: resource.resourceId,
    resourcePlanDigest,
  };

  const assertOwner = input.assertCurrentOwner;
  const { assertCurrent } = input;
  const readRetained = input.readRetainedResourceApproval;
  const currentBinding = () => structuredClone(binding);
  const guard = async (requested: HostedOperatorContext) => {
    if (!isDeepStrictEqual(requested, context)) {
      throw unavailable();
    }
    await assertOwner(structuredClone(context));
    await assertCurrent(currentBinding());
    if (
      !isDeepStrictEqual(
        nativeTargetAuthOnlyCredentialContextForPlan(profileInput),
        credentialContext,
      )
    ) {
      throw unavailable();
    }
    const currentProfile = resolveNativeTargetResourceProfile({
      appId: plan.appId,
      authority: plan.origin.authority,
      base: input.configuration,
      environment: input.environment,
      resourceProfileId: plan.authResource.profileId,
    });
    if (
      !isDeepStrictEqual(currentProfile.nativeNeon, native) ||
      currentProfile.sandbox.resourcesWorker.id !== resourcePlan.resourcesInstaller.reference ||
      currentProfile.sandbox.resourcesWorker.sha256 !== resourcePlan.resourcesInstaller.sha256
    ) {
      throw unavailable();
    }
    const retained = await readRetained(currentBinding());
    if (
      retained === undefined ||
      !isDeepStrictEqual(nativeTargetAuthOnlyPlanSchema.parse(retained.plan), plan) ||
      !Buffer.from(retained.approvedResourcePlanBytes).equals(resourceBytes) ||
      !isDeepStrictEqual(nativeTargetAuthOnlyApprovalSchema.parse(retained.approval), approval)
    ) {
      throw unavailable();
    }
    await assertCurrent(currentBinding());
    await assertOwner(structuredClone(context));
  };
  // Reuse only verified owner/native-store reads. Their planning scope grants no credential access.
  const owner = createNativePreviewNeonPlanningAuthority({
    context,
    controlPlane: {
      assertCanonicalOwner: guard,
      assertPlanningAuthorized: guard,
      readCredential: input.readCredential,
    },
    diagnosticSink: input.diagnosticSink,
    fetch: input.fetch,
    nativeStore: native.configuration.nativeStore,
    scope,
  });
  const reader = createPreviewNeonMcpReader({
    assertApprovedOwner: async (requested, requestedScope, store) => {
      await guard(requested);
      await owner.assertPlanningOwner(requested, requestedScope, store);
      await guard(requested);
    },
    assertApprovedScope: async (requested, requestedScope) => {
      if (!isDeepStrictEqual(requestedScope, scope)) throw unavailable();
      await guard(requested);
    },
    configuration: native.configuration,
    diagnosticSink: input.diagnosticSink,
    io: input.io,
    readCurrentOwnerNativeStore: owner.readCurrentOwnerNativeStore,
  });
  return {
    async withMaintenanceCredential<T>(consume: (material: Material) => Promise<T>): Promise<T> {
      try {
        await guard(context);
        return await reader.withMaintenanceCredential(context, scope, consume);
      } catch {
        throw unavailable();
      }
    },
  };
};
