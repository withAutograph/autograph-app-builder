import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-resource-plan-schema";
import { nativeTargetAuthOnlyPreviewDeliveryPlanSchema } from "./native-target-auth-only-preview-delivery";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const id = z.string().min(1);

/** Separately approved exact deploy bytes; no app database or product-data effect is representable. */
export const nativeTargetAuthOnlyDeliveryPlanSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("native-target-auth-only-delivery"),
  authOnlyPlanDigest: digest,
  resourcePlanDigest: digest,
  target: hostedRuntimeTargetSchema,
  source: z.strictObject({ branch: id, gitSha: sha, repositoryId: id }),
  delivery: nativeTargetAuthOnlyPreviewDeliveryPlanSchema,
  effects: z.tuple([
    z.strictObject({
      id: z.literal("auth-only-gateway-preview"),
      kind: z.literal("gateway-delivery"),
    }),
    z.strictObject({ id: z.literal("auth-only-app-preview"), kind: z.literal("delivery") }),
  ]),
});
export type NativeTargetAuthOnlyDeliveryPlan = z.infer<
  typeof nativeTargetAuthOnlyDeliveryPlanSchema
>;

/** Build only from the retained Auth plan, exact resource plan and current registered Preview project. */
export const buildNativeTargetAuthOnlyDeliveryPlanBytes = (input: {
  plan: NativeTargetAuthOnlyPlan;
  resourcePlanDigest: string;
  resourcePlanBytes: Buffer;
  selected: HostedOperatorSourceConfiguration;
  registration: { ownerUserId: string; sessionId: string; projectId: string; branch: string };
}) => {
  const plan = input.plan;
  const resource = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(
    JSON.parse(Buffer.from(input.resourcePlanBytes).toString("utf8")),
  );
  const source = plan.publishedSource;
  const gateway = input.selected.gateway;
  if (
    input.registration.ownerUserId !== plan.origin.authority.ownerUserId ||
    input.registration.sessionId !== plan.origin.publicSessionId ||
    input.registration.branch !== plan.branch ||
    resource.target.projectId !== input.registration.projectId ||
    resource.authOnlyPlanDigest !== nativeTargetAuthOnlyPlanDigest(plan) ||
    source.branch !== plan.branch ||
    source.repositoryId.length === 0 ||
    source.gitSha.length !== 40 ||
    gateway.environment !== "preview" ||
    gateway.projectId === input.registration.projectId
  )
    throw new Error("native_target_auth_only_delivery_mismatch");

  const delivery = nativeTargetAuthOnlyPreviewDeliveryPlanSchema.parse({
    action: "prepare",
    stage: "app",
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    delivery: {
      branch: plan.branch,
      gitSha: source.gitSha,
      projectId: input.registration.projectId,
      projectSettings: plan.project.projectSettings,
      repoId: source.repositoryId,
    },
    gatewayDelivery: {
      branch: gateway.branch,
      gitRef: gateway.branch,
      gitSha: gateway.gitSha,
      projectId: gateway.projectId,
      repoId: gateway.repoId,
    },
    publicGateway: {
      authBrowserOrigin: gateway.authBrowserOrigin,
      branch: gateway.branch,
      gatewayOrigin: gateway.gatewayOrigin,
      origin: gateway.publicOrigin,
      projectId: gateway.projectId,
      protectedApplicationIds: gateway.protectedApplicationIds,
    },
  });
  const target = hostedRuntimeTargetSchema.parse(resource.target);
  const retained = nativeTargetAuthOnlyDeliveryPlanSchema.parse({
    version: 1,
    kind: "native-target-auth-only-delivery",
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    resourcePlanDigest: digest.parse(input.resourcePlanDigest),
    target,
    source: { branch: source.branch, gitSha: source.gitSha, repositoryId: source.repositoryId },
    delivery,
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
  });
  return Buffer.from(JSON.stringify(retained));
};

export const nativeTargetAuthOnlyDeliveryPlanDigest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
