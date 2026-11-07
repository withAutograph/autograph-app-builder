import { z } from "zod";

import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import type { HostedOperatorPlan, OperatorDeploymentCandidate } from "./hosted-operator-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorDeploymentContext } from "./hosted-operator-service";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";
import {
  createHostedOperatorDeploymentDelivery,
  type GatewayAliasDiagnostic,
} from "./hosted-operator-deployment-delivery";
import type { RetentionRenewalDeliveryProvenance } from "./hosted-operator-retention-renewal";
import type { SharedHostProtectionDeliveryProvenance } from "./hosted-operator-shared-host-protection-successor";
import type { NativeTargetAuthOnlySchemaApproval } from "./hosted-operator-auth-only-runtime";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const id = z.string().min(1);

/** The delivery fields the shared Preview engine actually reads; deliberately excludes appDatabase. */
export const nativeTargetAuthOnlyPreviewDeliveryPlanSchema = z.strictObject({
  action: z.literal("prepare"),
  appDeliveryReplacement: z.unknown().optional(),
  delivery: z
    .strictObject({
      branch: id,
      gitSha: shaSchema.optional(),
      projectId: id,
      projectSettings: z.unknown().optional(),
      repoId: id,
    })
    .optional(),
  deploymentBoundary: z
    .object({ app: z.object({ branch: id }).optional() })
    .passthrough()
    .optional(),
  effects: z.array(z.strictObject({ id, kind: z.enum(["delivery", "gateway-delivery"]) })).min(1),
  gatewayDelivery: z
    .strictObject({
      branch: id,
      gitRef: id.optional(),
      gitSha: shaSchema.optional(),
      projectId: id,
      repoId: id,
    })
    .optional(),
  hostProtection: z.unknown().optional(),
  publicGateway: z
    .object({
      authBrowserOrigin: id,
      branch: id,
      gatewayOrigin: id,
      origin: id,
      projectId: id,
    })
    .passthrough()
    .optional(),
  stage: z.literal("app"),
});
export type NativeTargetAuthOnlyPreviewDeliveryPlan = z.infer<
  typeof nativeTargetAuthOnlyPreviewDeliveryPlanSchema
>;

export interface NativeTargetAuthOnlyPreviewDeliveryInput {
  authority: HostedOperatorDeploymentContext["authority"];
  target: HostedRuntimeTarget;
  /** Exact digest already settled by the Auth-only owner approval. */
  approvedPlanDigest: string;
  approval: NativeTargetAuthOnlySchemaApproval;
  operationRef: string;
  fenceGeneration: number;
  effectId: string;
  plan: NativeTargetAuthOnlyPreviewDeliveryPlan;
  deliveryCandidates?: OperatorDeploymentCandidate[];
  checkpointDelivery: HostedOperatorDeploymentContext["checkpointDelivery"];
  priorAppDelivery?: HostedOperatorDeploymentContext["priorAppDelivery"];
  deliveryCorrections?: HostedOperatorDeploymentContext["deliveryCorrections"];
  checkpointDeliveryCorrection?: HostedOperatorDeploymentContext["checkpointDeliveryCorrection"];
  gatewayDeliveryProvenance?: readonly SharedHostProtectionDeliveryProvenance[];
  renewalDeliveryProvenance?: readonly RetentionRenewalDeliveryProvenance[];
  /** Must re-read owner, approval, runtime lease, and current fence on every call. */
  assertCurrent: () => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Reuse the established Vercel candidate reconciliation, deployment readback,
 * and Gateway alias handling for an Auth-only Preview. The projection contains
 * only delivery authority; the approved Auth digest and current fence stay with
 * the caller. No product database, resource grant, or replacement is invented.
 */
export const createNativeTargetAuthOnlyPreviewDelivery = (deps: {
  readCredential: Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["readCredential"];
  assertEnvironment: (input: HostedOperatorDeploymentContext) => Promise<void>;
  fetch?: typeof fetch;
  target?: "app" | "gateway";
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  observeAlias?: (diagnostic: GatewayAliasDiagnostic) => void | Promise<void>;
  beforeAliasWrite?: Parameters<
    typeof createHostedOperatorDeploymentDelivery
  >[0]["beforeAliasWrite"];
}) => {
  const delivery = createHostedOperatorDeploymentDelivery({
    assertAuthorized: async () => {},
    assertEnvironment: deps.assertEnvironment,
    readCredential: deps.readCredential,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.target === undefined ? {} : { target: deps.target }),
    ...(deps.wait === undefined ? {} : { wait: deps.wait }),
    ...(deps.observeAlias === undefined ? {} : { observeAlias: deps.observeAlias }),
    ...(deps.beforeAliasWrite === undefined ? {} : { beforeAliasWrite: deps.beforeAliasWrite }),
    approvedPlanDigest: (input) => {
      const bound = input as HostedOperatorDeploymentContext & {
        approvedPlanDigest: string;
      };
      return digestSchema.parse(bound.approvedPlanDigest);
    },
  });

  return {
    async deliver(input: NativeTargetAuthOnlyPreviewDeliveryInput) {
      const plan = nativeTargetAuthOnlyPreviewDeliveryPlanSchema.parse(input.plan);
      const target = { ...input.target };
      const kind = deps.target === "gateway" ? "gateway-delivery" : "delivery";
      const selected = plan.effects.filter((effect) => effect.id === input.effectId);
      const sourceDelivery = deps.target === "gateway" ? plan.gatewayDelivery : plan.delivery;
      const expectedProjectId =
        deps.target === "gateway" ? plan.publicGateway?.projectId : target.projectId;
      const expectedBranch =
        deps.target === "gateway"
          ? plan.publicGateway?.branch
          : (plan.deploymentBoundary?.app?.branch ?? target.branch);
      if (
        target.environment !== "preview" ||
        input.approval.outcome !== "approved" ||
        input.approval.planDigest !== digestSchema.parse(input.approvedPlanDigest) ||
        input.approval.publicSessionId !== target.sessionId ||
        input.approval.responderPrincipalId !== input.authority.ownerUserId ||
        plan.effects.filter((effect) => effect.kind === kind).length !== 1 ||
        selected.length !== 1 ||
        selected[0]?.kind !== kind ||
        sourceDelivery === undefined ||
        sourceDelivery.projectId !== expectedProjectId ||
        sourceDelivery.branch !== expectedBranch ||
        !Number.isSafeInteger(input.fenceGeneration) ||
        input.fenceGeneration <= 0
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }

      const legacyProjection = {
        ...plan,
        delivery: plan.delivery,
      } as unknown as HostedOperatorPlan;
      const context = {
        authority: structuredClone(input.authority),
        target,
        effect: { id: input.effectId, kind },
        fenceGeneration: input.fenceGeneration,
        operationRef: id.parse(input.operationRef),
        plan: legacyProjection,
        deliveryCandidates: structuredClone(input.deliveryCandidates ?? []),
        ...(input.priorAppDelivery === undefined
          ? {}
          : { priorAppDelivery: structuredClone(input.priorAppDelivery) }),
        ...(input.deliveryCorrections === undefined
          ? {}
          : { deliveryCorrections: structuredClone(input.deliveryCorrections) }),
        ...(input.checkpointDeliveryCorrection === undefined
          ? {}
          : { checkpointDeliveryCorrection: input.checkpointDeliveryCorrection }),
        ...(input.gatewayDeliveryProvenance === undefined
          ? {}
          : { gatewayDeliveryProvenance: structuredClone(input.gatewayDeliveryProvenance) }),
        ...(input.renewalDeliveryProvenance === undefined
          ? {}
          : { renewalDeliveryProvenance: structuredClone(input.renewalDeliveryProvenance) }),
        checkpointDelivery: input.checkpointDelivery,
        workerCheckpoints: [],
        assertCurrent: input.assertCurrent,
        checkpoint: async () => {},
        approvedPlanDigest: digestSchema.parse(input.approvedPlanDigest),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      } as unknown as HostedOperatorDeploymentContext;
      return await delivery.deliver(context);
    },
    async reconcile(input: NativeTargetAuthOnlyPreviewDeliveryInput) {
      const plan = nativeTargetAuthOnlyPreviewDeliveryPlanSchema.parse(input.plan);
      const kind = deps.target === "gateway" ? "gateway-delivery" : "delivery";
      const selected = plan.effects.filter((effect) => effect.id === input.effectId);
      const sourceDelivery = deps.target === "gateway" ? plan.gatewayDelivery : plan.delivery;
      const expectedProjectId =
        deps.target === "gateway" ? plan.publicGateway?.projectId : input.target.projectId;
      const expectedBranch =
        deps.target === "gateway"
          ? plan.publicGateway?.branch
          : (plan.deploymentBoundary?.app?.branch ?? input.target.branch);
      if (
        input.target.environment !== "preview" ||
        selected.length !== 1 ||
        input.approval.outcome !== "approved" ||
        input.approval.planDigest !== digestSchema.parse(input.approvedPlanDigest) ||
        input.approval.publicSessionId !== input.target.sessionId ||
        input.approval.responderPrincipalId !== input.authority.ownerUserId ||
        plan.effects.filter((effect) => effect.kind === kind).length !== 1 ||
        selected[0]?.kind !== kind ||
        sourceDelivery === undefined ||
        sourceDelivery.projectId !== expectedProjectId ||
        sourceDelivery.branch !== expectedBranch ||
        !Number.isSafeInteger(input.fenceGeneration) ||
        input.fenceGeneration <= 0
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const context = {
        authority: structuredClone(input.authority),
        target: { ...input.target },
        effect: { id: input.effectId, kind },
        fenceGeneration: input.fenceGeneration,
        operationRef: id.parse(input.operationRef),
        plan: { ...plan } as unknown as HostedOperatorPlan,
        deliveryCandidates: structuredClone(input.deliveryCandidates ?? []),
        ...(input.priorAppDelivery === undefined
          ? {}
          : { priorAppDelivery: structuredClone(input.priorAppDelivery) }),
        ...(input.deliveryCorrections === undefined
          ? {}
          : { deliveryCorrections: structuredClone(input.deliveryCorrections) }),
        ...(input.checkpointDeliveryCorrection === undefined
          ? {}
          : { checkpointDeliveryCorrection: input.checkpointDeliveryCorrection }),
        ...(input.gatewayDeliveryProvenance === undefined
          ? {}
          : { gatewayDeliveryProvenance: structuredClone(input.gatewayDeliveryProvenance) }),
        ...(input.renewalDeliveryProvenance === undefined
          ? {}
          : { renewalDeliveryProvenance: structuredClone(input.renewalDeliveryProvenance) }),
        checkpointDelivery: input.checkpointDelivery,
        workerCheckpoints: [],
        assertCurrent: input.assertCurrent,
        checkpoint: async () => {},
        approvedPlanDigest: digestSchema.parse(input.approvedPlanDigest),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      } as unknown as HostedOperatorDeploymentContext;
      return await delivery.reconcile(context);
    },
  };
};
