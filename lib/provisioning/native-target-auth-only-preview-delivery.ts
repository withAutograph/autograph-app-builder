import { z } from "zod";

import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import type { OperatorDeploymentCandidate } from "./hosted-operator-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorDeploymentContext } from "./hosted-operator-service";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";
import { createHostedOperatorDeploymentDelivery } from "./hosted-operator-deployment-delivery";
import type { GatewayAliasDiagnostic } from "./hosted-operator-deployment-delivery";
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
  deploymentBoundary: z.looseObject({ app: z.object({ branch: id }).optional() }).optional(),
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
    .looseObject({
      authBrowserOrigin: id,
      branch: id,
      gatewayOrigin: id,
      origin: id,
      projectId: id,
    })
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
    assertAuthorized: async () => {
      // The shared engine invokes the projection's real assertCurrent immediately before this legacy hook.
    },
    assertEnvironment: deps.assertEnvironment,
    readCredential: deps.readCredential,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.target === undefined ? {} : { target: deps.target }),
    ...(deps.wait === undefined ? {} : { wait: deps.wait }),
    ...(deps.observeAlias === undefined ? {} : { observeAlias: deps.observeAlias }),
    ...(deps.beforeAliasWrite === undefined ? {} : { beforeAliasWrite: deps.beforeAliasWrite }),
    approvedPlanDigest: (input) =>
      z.object({ approvedPlanDigest: digestSchema }).parse(input).approvedPlanDigest,
  });

  const assertDeliveryInput = (
    input: NativeTargetAuthOnlyPreviewDeliveryInput,
    plan: NativeTargetAuthOnlyPreviewDeliveryPlan,
    target: HostedRuntimeTarget,
    reconciling: boolean,
  ) => {
    const kind = deps.target === "gateway" ? "gateway-delivery" : "delivery";
    const selected = plan.effects.filter((effect) => effect.id === input.effectId);
    const source = deps.target === "gateway" ? plan.gatewayDelivery : plan.delivery;
    const expectedProjectId =
      deps.target === "gateway" ? plan.publicGateway?.projectId : target.projectId;
    const expectedBranch =
      deps.target === "gateway"
        ? plan.publicGateway?.branch
        : (plan.deploymentBoundary?.app?.branch ?? target.branch);
    const mismatch = () => new HostedOperatorError("resource_mismatch");
    // Keep the original validation order, including malformed digest errors after the earlier scope checks.
    if (target.environment !== "preview") {
      throw mismatch();
    }
    if (reconciling && selected.length !== 1) {
      throw mismatch();
    }
    if (input.approval.outcome !== "approved") {
      throw mismatch();
    }
    if (input.approval.planDigest !== digestSchema.parse(input.approvedPlanDigest)) {
      throw mismatch();
    }
    const exactApproval = [
      input.approval.publicSessionId === target.sessionId,
      input.approval.responderPrincipalId === input.authority.ownerUserId,
    ];
    if (!exactApproval.every(Boolean)) {
      throw mismatch();
    }
    const exactEffect = [
      plan.effects.filter((effect) => effect.kind === kind).length === 1,
      selected.length === 1,
      selected[0]?.kind === kind,
    ];
    if (!exactEffect.every(Boolean) || source === undefined) {
      throw mismatch();
    }
    if (
      ![
        source.projectId === expectedProjectId,
        source.branch === expectedBranch,
        Number.isSafeInteger(input.fenceGeneration),
        input.fenceGeneration > 0,
      ].every(Boolean)
    ) {
      throw mismatch();
    }
    return kind;
  };
  const projectContext = (
    input: NativeTargetAuthOnlyPreviewDeliveryInput,
    plan: NativeTargetAuthOnlyPreviewDeliveryPlan,
    target: HostedRuntimeTarget,
    kind: "gateway-delivery" | "delivery",
    delivering: boolean,
  ) =>
    // SAFETY: The legacy engine's context type includes database preparation fields, but its delivery path reads only this validated plan subset, target/effect, candidates, provenance and live callbacks. The digest callback above avoids full database-plan parsing. Real assertCurrent, environment and alias guards remain active in the shared engine.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- This single validated adapter boundary crosses the wider legacy signature; adding its unused database fields would invent authority.
    ({
      authority: structuredClone(input.authority),
      target,
      effect: { id: input.effectId, kind },
      fenceGeneration: input.fenceGeneration,
      operationRef: id.parse(input.operationRef),
      plan: delivering ? { ...plan, delivery: plan.delivery } : { ...plan },
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
      checkpoint: async () => {
        // Delivery does not write an Auth worker or product-data checkpoint through the legacy worker port.
      },
      approvedPlanDigest: digestSchema.parse(input.approvedPlanDigest),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }) as unknown as HostedOperatorDeploymentContext;
  return {
    async deliver(input: NativeTargetAuthOnlyPreviewDeliveryInput) {
      const plan = nativeTargetAuthOnlyPreviewDeliveryPlanSchema.parse(input.plan);
      const target = { ...input.target };
      const kind = assertDeliveryInput(input, plan, target, false);
      return await delivery.deliver(projectContext(input, plan, target, kind, true));
    },
    async reconcile(input: NativeTargetAuthOnlyPreviewDeliveryInput) {
      const plan = nativeTargetAuthOnlyPreviewDeliveryPlanSchema.parse(input.plan);
      const kind = assertDeliveryInput(input, plan, input.target, true);
      return await delivery.reconcile(
        projectContext(input, plan, { ...input.target }, kind, false),
      );
    },
  };
};
