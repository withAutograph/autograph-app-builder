import type {
  CentralHostSetupPlan,
  CentralHostCallerPlan,
} from "./central-integration-host-contract";
import { z } from "zod";

const AUTHORIZE_APP_CENTRAL_CALLER = "authorize-app-central-caller";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const centralExecutionLeaseSchema = z.strictObject({
  leaseId: z.uuid(),
  fenceGeneration: generation,
});
export const centralEffectReceiptSchema = z.discriminatedUnion("effect", [
  z.strictObject({
    effect: z.literal("prepare-central-resources"),
    resourceId: id,
    resourceVersion: id,
    readbackSha256: digest,
  }),
  z.strictObject({
    effect: z.literal("install-central-schema"),
    resourceProfileId: id,
    schemaSha256: digest,
    configurationSha256: digest,
    centralPrincipalGeneration: generation,
  }),
  z.strictObject({ effect: z.literal("register-deployment-receiver"), id, secretSha256: digest }),
  z.strictObject({
    effect: z.enum(["authorize-central-inspector", AUTHORIZE_APP_CENTRAL_CALLER]),
    projectId: id,
    callerProjectId: id,
    environment: z.enum(["preview", "production"]),
    targetEnvironment: z.literal("preview"),
    trustedSourcesSha256: digest,
    trustedSourcesGrantSha256: digest,
  }),
  z.strictObject({ effect: z.literal("bind-central-preview-runtime"), environmentSha256: digest }),
  z.strictObject({
    effect: z.literal("publish-central-host-source"),
    repositoryId: id,
    branch: id,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
]);
export type CentralEffectReceipt = z.infer<typeof centralEffectReceiptSchema>;
export const centralEffectAttemptSchema = z.strictObject({
  attemptId: z.uuid(),
  attemptGeneration: generation,
  grantAttempt: z.strictObject({ beforeSha256: digest, afterSha256: digest }).optional(),
  receipt: centralEffectReceiptSchema.optional(),
});
export type CentralEffectAttempt = z.infer<typeof centralEffectAttemptSchema>;
export const centralRuntimeBindingSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("idle") }),
  z.strictObject({
    state: z.literal("pending"),
    attemptGeneration: generation,
    acceptedEnvId: id.optional(),
  }),
  z.strictObject({ state: z.literal("applied"), attemptGeneration: generation, acceptedEnvId: id }),
]);
export type CentralRuntimeBinding = z.infer<typeof centralRuntimeBindingSchema>;
export const centralEffectReceiptMatches = (
  plan: CentralHostSetupPlan | CentralHostCallerPlan,
  receipt: CentralEffectReceipt,
  attemptGeneration: number,
): boolean => {
  if (plan.kind === "central-integration-host-caller-v1") {
    return (
      receipt.effect === AUTHORIZE_APP_CENTRAL_CALLER &&
      receipt.projectId === plan.central.projectId &&
      receipt.callerProjectId === plan.caller.projectId &&
      receipt.environment === plan.caller.environment
    );
  }
  switch (receipt.effect) {
    case "prepare-central-resources": {
      return receipt.resourceId === plan.control.resource.resourceId;
    }
    case "install-central-schema": {
      return (
        receipt.resourceProfileId === plan.resourceProfileId &&
        receipt.schemaSha256 === plan.control.schemaSha256 &&
        receipt.configurationSha256 === plan.source.configurationSha256 &&
        receipt.centralPrincipalGeneration === attemptGeneration
      );
    }
    case "register-deployment-receiver": {
      return true;
    }
    case "authorize-central-inspector": {
      return (
        receipt.projectId === plan.target.projectId &&
        receipt.callerProjectId === plan.inspector.projectId &&
        receipt.environment === plan.inspector.environment
      );
    }
    case "bind-central-preview-runtime": {
      return true;
    }
    case "publish-central-host-source": {
      return (
        receipt.repositoryId === plan.source.repositoryId &&
        receipt.branch === plan.source.operationBranch &&
        receipt.sourceSha === plan.source.reviewedSourceSha
      );
    }
    // A caller grant cannot satisfy a distinct infrastructure setup effect.
    case AUTHORIZE_APP_CENTRAL_CALLER: {
      return false;
    }
    default: {
      return false;
    }
  }
};
