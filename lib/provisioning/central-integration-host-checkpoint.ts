import type {
  CentralHostSetupPlan,
  CentralHostCallerPlan,
} from "./central-integration-host-contract";
import { z } from "zod";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const previewEnvironment = z.literal("preview");
const authorizeAppCentralCaller = "authorize-app-central-caller";
export const centralExecutionLeaseSchema = z.strictObject({
  fenceGeneration: generation,
  leaseId: z.uuid(),
});
export const centralEffectReceiptSchema = z.discriminatedUnion("effect", [
  z.strictObject({
    effect: z.literal("prepare-central-resources"),
    readbackSha256: digest,
    resourceId: id,
    resourceVersion: id,
  }),
  z.strictObject({
    centralPrincipalGeneration: generation,
    configurationSha256: digest,
    effect: z.literal("install-central-schema"),
    resourceProfileId: id,
    schemaSha256: digest,
  }),
  z.strictObject({ effect: z.literal("register-deployment-receiver"), id, secretSha256: digest }),
  z.strictObject({
    callerProjectId: id,
    effect: z.enum(["authorize-central-inspector", authorizeAppCentralCaller]),
    environment: z.enum(["preview", "production"]),
    projectId: id,
    targetEnvironment: previewEnvironment,
    trustedSourcesGrantSha256: digest,
    trustedSourcesSha256: digest,
  }),
  z.strictObject({ effect: z.literal("bind-central-preview-runtime"), environmentSha256: digest }),
  z.strictObject({
    branch: id,
    effect: z.literal("publish-central-host-source"),
    repositoryId: id,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  }),
]);
export type CentralEffectReceipt = z.infer<typeof centralEffectReceiptSchema>;
export const centralEffectAttemptSchema = z.strictObject({
  attemptGeneration: generation,
  attemptId: z.uuid(),
  grantAttempt: z.strictObject({ afterSha256: digest, beforeSha256: digest }).optional(),
  receipt: centralEffectReceiptSchema.optional(),
});
export type CentralEffectAttempt = z.infer<typeof centralEffectAttemptSchema>;
export const centralRuntimeBindingSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("idle") }),
  z.strictObject({
    acceptedEnvId: id.optional(),
    attemptGeneration: generation,
    state: z.literal("pending"),
  }),
  z.strictObject({ acceptedEnvId: id, attemptGeneration: generation, state: z.literal("applied") }),
]);
export type CentralRuntimeBinding = z.infer<typeof centralRuntimeBindingSchema>;
export const centralEffectReceiptMatches = (
  plan: CentralHostSetupPlan | CentralHostCallerPlan,
  receipt: CentralEffectReceipt,
  attemptGeneration: number,
): boolean => {
  if (plan.kind === "central-integration-host-caller-v1") {
    return (
      receipt.effect === authorizeAppCentralCaller &&
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
    case authorizeAppCentralCaller: {
      return false;
    }
    default: {
      return false;
    }
  }
};
