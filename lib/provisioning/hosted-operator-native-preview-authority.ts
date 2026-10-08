import { z } from "zod";
import { readOwnerVercelProjectAccess } from "../agent/prepared-provider-context";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { hostedRuntimeIdentity, hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { readVercelManagedNeonResource } from "./hosted-runtime-marketplace-resource";
import type {
  NativePreviewNeonDependencies,
  NativePreviewNeonStoreBinding,
  NativePreviewNeonScope,
} from "./hosted-operator-native-preview-neon";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
} from "./hosted-operator-service";

type ControlPlane = Pick<
  Awaited<ReturnType<typeof createHostedOperatorControlPlane>>,
  "store" | "assertAuthorized" | "readApproval" | "readCredential"
>;
interface Input<Effect extends HostedOperatorEffectContext> {
  controlPlane: ControlPlane;
  effect: Effect;
  nativeStore: Readonly<NativePreviewNeonStoreBinding>;
  fetch?: typeof fetch;
  now?: () => number;
}
type Callbacks = Pick<
  NativePreviewNeonDependencies,
  "assertApprovedScope" | "readCurrentOwnerNativeStore"
>;
const fail = () => new HostedOperatorError("authorization_required");
const sameStore = (left: NativePreviewNeonStoreBinding, right: NativePreviewNeonStoreBinding) =>
  left.configurationId === right.configurationId &&
  left.resourceId === right.resourceId &&
  left.sourceProjectId === right.sourceProjectId;

const assertPending = (
  operator: NonNullable<HostedRuntimeJournalRecord["operator"]>,
  effectId: string,
  executionAttemptId?: string,
) => {
  const pending = operator.pendingEffectAttempt;
  if (executionAttemptId !== undefined) {
    if (operator.pendingEffectId !== effectId || pending?.id !== executionAttemptId) {
      throw fail();
    }
  } else if (
    (operator.pendingEffectId !== undefined || pending !== undefined) &&
    (operator.pendingEffectId !== effectId || pending === undefined)
  ) {
    throw fail();
  }
};

const readVerifiedOwnerNativeStore = async (
  input: {
    assertCurrentOwner: (context: HostedOperatorContext) => Promise<void>;
    readCredential: ControlPlane["readCredential"];
    nativeStore: Readonly<NativePreviewNeonStoreBinding>;
    neonProjectId: string;
    fetch?: typeof fetch;
  },
  context: HostedOperatorContext,
  binding: NativePreviewNeonStoreBinding,
) => {
  if (
    !sameStore(binding, input.nativeStore) ||
    binding.sourceProjectId === context.target.projectId
  ) {
    throw fail();
  }
  await input.assertCurrentOwner(context);
  const readCredential = async () => {
    await input.assertCurrentOwner(context);
    const credential = await input.readCredential(context.authority, context.target.installationId);
    if (
      credential?.binding.active !== true ||
      credential.binding.installationId !== context.target.installationId ||
      credential.binding.scopeId !== context.target.scopeId ||
      credential.binding.scopeType !== context.target.scopeType
    ) {
      throw fail();
    }
    await input.assertCurrentOwner(context);
    return credential;
  };
  const access = await readOwnerVercelProjectAccess({
    authority: context.authority,
    fetch: input.fetch ?? fetch,
    installationId: context.target.installationId,
    projectId: binding.sourceProjectId,
    readCredential,
  });
  if (
    access.status !== "ready" ||
    access.project?.id !== binding.sourceProjectId ||
    access.scope.id !== context.target.scopeId ||
    access.scope.type !== context.target.scopeType
  ) {
    throw fail();
  }
  await input.assertCurrentOwner(context);
  const native = await readVercelManagedNeonResource({
    configurationId: binding.configurationId,
    fail,
    projectId: binding.sourceProjectId,
    request: async (pathname) => {
      await input.assertCurrentOwner(context);
      const credential = await readCredential();
      const url = new URL(pathname, "https://api.vercel.com");
      if (context.target.scopeType === "team") {
        url.searchParams.set("teamId", context.target.scopeId);
      }
      const response = await (input.fetch ?? fetch)(url, {
        cache: "no-store",
        headers: { Accept: "application/json", Authorization: `Bearer ${credential.token}` },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      try {
        if (!response.ok) {
          throw fail();
        }
        const raw: unknown = await response.json();
        const value = z.json().parse(raw);
        await input.assertCurrentOwner(context);
        return value;
      } finally {
        if (!response.bodyUsed) {
          await response.body?.cancel();
        }
      }
    },
    scopeId: context.target.scopeId,
  });
  if (native.resourceId !== binding.resourceId || native.neonProjectId !== input.neonProjectId) {
    throw fail();
  }
  await input.assertCurrentOwner(context);
  return {
    configurationId: binding.configurationId,
    neonProjectId: native.neonProjectId,
    ownerId: access.scope.id,
    resourceId: native.resourceId,
    vercelProjectId: access.project.id,
  };
};

const createAuthority = (
  input: Input<HostedOperatorEffectContext>,
  executionAttemptId?: string,
): Callbacks => {
  const plan = hostedOperatorPlanSchema.parse(input.effect.plan);
  const effect = Object.freeze({
    ...input.effect,
    authority: Object.freeze({ ...input.effect.authority }),
    plan,
    target: Object.freeze({ ...input.effect.target }),
  });
  const expectedStore = Object.freeze({ ...input.nativeStore });
  const now = input.now ?? Date.now;
  const identity = hostedRuntimeIdentity(effect.authority, effect.target).digest;
  const planDigest = operatorPlanDigest(plan);
  const assertPhase = async (context: HostedOperatorContext) => {
    if (hostedRuntimeIdentity(context.authority, context.target).digest !== identity) {
      throw fail();
    }
    await effect.assertCurrent();
    await input.controlPlane.assertAuthorized(effect);
    const row = await input.controlPlane.store.read(effect);
    const parsed = hostedRuntimeJournalRecordSchema.safeParse(row?.record);
    if (!parsed.success) {
      throw fail();
    }
    const record = parsed.data;
    const { operator } = record;
    if (
      operator === undefined ||
      record.leaseId === undefined ||
      record.leaseExpiresAt === undefined
    ) {
      throw fail();
    }
    const bootstrapPhase = effect.effect.kind === "resources" && plan.action === "prepare";
    const retirementPhase =
      effect.effect.kind === "retire" &&
      plan.action === "cleanup" &&
      effect.effect.resourceId === plan.appDatabase.resourceId;
    const validPhase = [
      Date.parse(record.leaseExpiresAt) > now(),
      operator.operationRef === effect.operationRef,
      operator.fenceGeneration === effect.fenceGeneration,
      operator.planDigest === planDigest,
      operatorPlanDigest(operator.plan) === planDigest,
      hostedRuntimeIdentity(effect.authority, record.request).digest === identity,
      bootstrapPhase || retirementPhase,
      plan.bootstrap !== undefined,
      [plan.authDatabase.resourceId, plan.appDatabase.resourceId].includes(
        effect.effect.resourceId ?? "",
      ),
      JSON.stringify(plan.effects.find((entry) => entry.id === effect.effect.id)) ===
        JSON.stringify(effect.effect),
    ];
    if (!validPhase.every(Boolean)) {
      throw fail();
    }
    assertPending(operator, effect.effect.id, executionAttemptId);
    const approval = await input.controlPlane.readApproval({
      ...effect,
      action: plan.action,
      callId: record.approvedByCallId,
      planDigest,
    });
    const approved = [
      approval?.approved,
      approval?.approvalId === operator.approvalId,
      approval?.callId === record.approvedByCallId,
      approval?.planDigest === planDigest,
      approval?.action === plan.action,
    ];
    if (!approved.every(Boolean)) {
      throw fail();
    }
    await effect.assertCurrent();
    await input.controlPlane.assertAuthorized(effect);
  };
  const assertApprovedScope = async (
    context: HostedOperatorContext,
    scope: NativePreviewNeonScope,
  ) => {
    await assertPhase(context);
    const { bootstrap } = plan;
    if (bootstrap === undefined) {
      throw fail();
    }
    const matches = [
      scope.projectId === plan.neon.projectId,
      scope.branchId === plan.neon.branchId,
      scope.hostname === plan.neon.endpoint,
      scope.endpointId === bootstrap.endpointId,
      scope.maintenanceDatabase === bootstrap.maintenanceDatabase,
      scope.maintenanceRole === bootstrap.role,
    ];
    if (!matches.every(Boolean)) {
      throw fail();
    }
    await assertPhase(context);
  };
  return {
    assertApprovedScope,
    async readCurrentOwnerNativeStore(context, binding) {
      return await readVerifiedOwnerNativeStore(
        {
          assertCurrentOwner: assertPhase,
          fetch: input.fetch,
          nativeStore: expectedStore,
          neonProjectId: plan.neon.projectId,
          readCredential: input.controlPlane.readCredential,
        },
        context,
        binding,
      );
    },
  };
};

/** Construct only inside the existing leased resources worker; no request selects this authority. */
export const createNativePreviewNeonExecutionAuthority = (
  input: Input<HostedOperatorWorkerEffectContext>,
): Callbacks => createAuthority(input, z.uuid().parse(input.effect.workerAttemptId));

/** Read-only first inspection/recovery uses the recorded pending attempt, never creates a new one. */
export const createNativePreviewNeonReconciliationAuthority = (
  input: Input<HostedOperatorEffectContext>,
): Callbacks => createAuthority(input);

/** Current-owner read-only planning has no approval/effect/worker attempt and never returns a SQL URI. */
export const createNativePreviewNeonPlanningAuthority = (input: {
  controlPlane: Pick<
    Awaited<ReturnType<typeof createHostedOperatorControlPlane>>,
    "assertPlanningAuthorized" | "readCredential"
  >;
  context: HostedOperatorContext;
  nativeStore: Readonly<NativePreviewNeonStoreBinding>;
  scope: Readonly<NativePreviewNeonScope>;
  fetch?: typeof fetch;
}) => {
  const context = structuredClone({
    authority: input.context.authority,
    ownerContext: input.context.ownerContext,
    target: input.context.target,
  });
  const scope = structuredClone(input.scope);
  const nativeStore = structuredClone(input.nativeStore);
  const assertCurrentOwner = async (requested: HostedOperatorContext) => {
    if (
      hostedRuntimeIdentity(requested.authority, requested.target).digest !==
        hostedRuntimeIdentity(context.authority, context.target).digest ||
      requested.target.environment !== "preview"
    ) {
      throw fail();
    }
    await input.controlPlane.assertPlanningAuthorized(requested);
  };
  return {
    async assertPlanningScope(
      requested: HostedOperatorContext,
      requestedScope: NativePreviewNeonScope,
    ) {
      await assertCurrentOwner(requested);
      const matches = [
        requestedScope.projectId === scope.projectId,
        requestedScope.branchId === scope.branchId,
        requestedScope.endpointId === scope.endpointId,
        requestedScope.hostname === scope.hostname,
        requestedScope.maintenanceDatabase === scope.maintenanceDatabase,
        requestedScope.maintenanceRole === scope.maintenanceRole,
      ].every(Boolean);
      if (!matches) {
        throw fail();
      }
      await assertCurrentOwner(requested);
    },
    async readCurrentOwnerNativeStore(
      requested: HostedOperatorContext,
      binding: NativePreviewNeonStoreBinding,
    ) {
      return await readVerifiedOwnerNativeStore(
        {
          assertCurrentOwner,
          fetch: input.fetch,
          nativeStore,
          neonProjectId: scope.projectId,
          readCredential: input.controlPlane.readCredential,
        },
        requested,
        binding,
      );
    },
  };
};
