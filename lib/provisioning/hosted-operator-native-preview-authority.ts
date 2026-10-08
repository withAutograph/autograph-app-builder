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
    const validPhase = [
      Date.parse(record.leaseExpiresAt) > now(),
      operator.operationRef === effect.operationRef,
      operator.fenceGeneration === effect.fenceGeneration,
      operator.planDigest === planDigest,
      operatorPlanDigest(operator.plan) === planDigest,
      hostedRuntimeIdentity(effect.authority, record.request).digest === identity,
      effect.effect.kind === "resources",
      plan.action === "prepare",
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
      action: "prepare",
      callId: record.approvedByCallId,
      planDigest,
    });
    const approved = [
      approval?.approved,
      approval?.approvalId === operator.approvalId,
      approval?.callId === record.approvedByCallId,
      approval?.planDigest === planDigest,
      approval?.action === "prepare",
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
      if (
        !sameStore(binding, expectedStore) ||
        binding.sourceProjectId === effect.target.projectId
      ) {
        throw fail();
      }
      await assertPhase(context);
      const readCredential = async () => {
        await assertPhase(context);
        const credential = await input.controlPlane.readCredential(
          effect.authority,
          effect.target.installationId,
        );
        if (
          credential?.binding.active !== true ||
          credential.binding.installationId !== effect.target.installationId ||
          credential.binding.scopeId !== effect.target.scopeId ||
          credential.binding.scopeType !== effect.target.scopeType
        ) {
          throw fail();
        }
        await assertPhase(context);
        return credential;
      };
      const access = await readOwnerVercelProjectAccess({
        authority: effect.authority,
        fetch: input.fetch ?? fetch,
        installationId: effect.target.installationId,
        projectId: binding.sourceProjectId,
        readCredential,
      });
      if (
        access.status !== "ready" ||
        access.project?.id !== binding.sourceProjectId ||
        access.scope.id !== effect.target.scopeId ||
        access.scope.type !== effect.target.scopeType
      ) {
        throw fail();
      }
      await assertPhase(context);
      const native = await readVercelManagedNeonResource({
        configurationId: binding.configurationId,
        fail,
        projectId: binding.sourceProjectId,
        request: async (pathname) => {
          await assertPhase(context);
          const credential = await readCredential();
          const url = new URL(pathname, "https://api.vercel.com");
          if (effect.target.scopeType === "team") {
            url.searchParams.set("teamId", effect.target.scopeId);
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
            await assertPhase(context);
            return value;
          } finally {
            if (!response.bodyUsed) {
              await response.body?.cancel();
            }
          }
        },
        scopeId: effect.target.scopeId,
      });
      if (
        native.resourceId !== binding.resourceId ||
        native.neonProjectId !== plan.neon.projectId
      ) {
        throw fail();
      }
      await assertPhase(context);
      return {
        configurationId: binding.configurationId,
        neonProjectId: native.neonProjectId,
        ownerId: access.scope.id,
        resourceId: native.resourceId,
        vercelProjectId: access.project.id,
      };
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
