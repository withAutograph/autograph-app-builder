import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { githubPrDeliveryApprovalSchema } from "../agent/github-pr-delivery-approval";
import { repositoryProductionSchemaActivationSchema } from "../provisioning/repository-production-delivery";
import {
  repositoryProductionExpectedMergeShaSchema,
  repositoryProductionNativeStatusSchema,
} from "../provisioning/repository-production-native-status-contract";

const deliveryTool = "finish-github-pr-delivery";
const deliveryStep = "continueGitHubPrDelivery";
const schemaStep = "continueGitHubProductionSchema";
const unexpectedStepAfterStop = "unexpected-step-after-stop";
const schemaTargetMismatch = "schema-target-mismatch";
const readyAt = z.iso.datetime({ offset: true });
const deliveryTargetSchema = z.strictObject({
  appId: z.string().min(1),
  repositoryId: z.string().min(1),
  repositoryFullName: z.string().min(1),
});
const mergedSchema = z.strictObject({
  status: z.literal("merged"),
  mergeCommitSha: repositoryProductionExpectedMergeShaSchema,
  nativeProductionTarget: deliveryTargetSchema.optional(),
  schemaActivation: repositoryProductionSchemaActivationSchema
    .omit({
      mergeSha: true,
      reviewedHeadSha: true,
    })
    .optional(),
});
const waitingSchema = z.strictObject({ status: z.literal("waiting-for-checks"), readyAt });
const deliveryOutputSchema = z.union([waitingSchema, mergedSchema]);
const stepArgumentsSchema = z.tuple([
  z.strictObject({
    args: z.union([
      z.tuple([githubPrDeliveryApprovalSchema, z.null()]),
      z.tuple([
        githubPrDeliveryApprovalSchema,
        z.null(),
        z.union([readyAt, repositoryProductionSchemaActivationSchema]),
      ]),
    ]),
    context: z.looseObject({
      callId: z.string().min(1),
      toolName: z.literal(deliveryTool),
      session: z.looseObject({ id: z.string().min(1) }),
    }),
    contextIndexes: z.tuple([z.literal(1)]),
  }),
]);
const monitoringStoppedSchema = z.strictObject({
  status: z.literal("monitoring-stopped"),
  requestedRevision: z.literal("unassessed"),
});
const stepOutputSchema = z.strictObject({
  kind: z.literal("result"),
  output: z.unknown(),
  authorized: z.tuple([]),
});
const stepOutputMetadataSchema = z.object({
  kind: z.string(),
  authorized: z.array(z.unknown()).optional(),
});

export type GitHubDeliveryEffectRejection =
  | "invalid-approval"
  | "invalid-step-arguments"
  | "step-context-mismatch"
  | "step-approval-mismatch"
  | "unexpected-step-status"
  | "step-authorization-required"
  | "step-authorization-recorded"
  | "invalid-step-output"
  | typeof unexpectedStepAfterStop
  | "invalid-delivery-result"
  | "ready-cycle-mismatch"
  | "merge-target-mismatch"
  | "unexpected-schema-step"
  | "schema-activation-mismatch"
  | "invalid-schema-result"
  | typeof schemaTargetMismatch
  | "merge-result-missing"
  | "schema-not-confirmed-live"
  | "schema-provider-only"
  | "repeat-schema-not-expected"
  | "repeat-merge-step-missing"
  | "repeat-merge-step-has-ready-cycle"
  | "repeat-prior-call-missing"
  | "repeat-terminal-step-has-output";

type ReportRejection = (reason: GitHubDeliveryEffectRejection) => void;

const rejection =
  <T extends false | null>(value: T, report?: ReportRejection) =>
  (reason: GitHubDeliveryEffectRejection): T => {
    report?.(reason);
    return value;
  };

interface CompletedDeliveryStep {
  readonly name: string;
  readonly args: unknown;
  readonly output: unknown;
  readonly status?: "completed" | "failed" | "cancelled";
  readonly afterStop?: true;
}

interface DeliveryEffectEvidence {
  readonly callId: string;
  readonly logicalSessionId: string;
  readonly appId: string;
  readonly toolInput: unknown;
  readonly schemaChangeExpected: boolean;
  readonly completedSteps: readonly CompletedDeliveryStep[];
}

type Approval = z.infer<typeof githubPrDeliveryApprovalSchema>;

const readStepArguments = (
  step: CompletedDeliveryStep,
  input: DeliveryEffectEvidence,
  approval: Approval,
  report?: ReportRejection,
) => {
  const [wrapper] = stepArgumentsSchema.safeParse(step.args).data ?? [];
  const reject = rejection(null, report);
  if (wrapper === undefined) {
    return reject("invalid-step-arguments");
  }
  if (
    wrapper.context.callId !== input.callId ||
    wrapper.context.session.id !== input.logicalSessionId
  ) {
    return reject("step-context-mismatch");
  }
  return isDeepStrictEqual(wrapper.args[0], approval)
    ? wrapper.args
    : reject("step-approval-mismatch");
};

const readStep = (
  step: CompletedDeliveryStep,
  input: DeliveryEffectEvidence,
  approval: Approval,
  report?: ReportRejection,
) => {
  const reject = rejection(null, report);
  if (step.status !== undefined && step.status !== "completed") {
    return reject("unexpected-step-status");
  }
  const args = readStepArguments(step, input, approval, report);
  if (args === null) {
    return null;
  }
  const result = stepOutputSchema.safeParse(step.output).data;
  if (result !== undefined) {
    return { argument: args[2], output: result.output };
  }
  const metadata = stepOutputMetadataSchema.safeParse(step.output).data;
  if (metadata?.kind === "authorization-required") {
    return reject("step-authorization-required");
  }
  if (metadata?.authorized !== undefined && metadata.authorized.length > 0) {
    return reject("step-authorization-recorded");
  }
  return reject("invalid-step-output");
};

const deliveryDestination = (approval: Approval) => ({
  repositoryId: approval.repositoryId,
  repositoryFullName: `${approval.owner}/${approval.name}`,
});

/** Check the retained writes of a natively bound child without creating a tool result or replay authority. */
export const hasSettledGitHubDeliveryEffects = (
  input: DeliveryEffectEvidence,
  report?: ReportRejection,
): boolean => {
  const reject = rejection(false, report);
  const approval = githubPrDeliveryApprovalSchema.safeParse(input.toolInput).data;
  if (
    approval === undefined ||
    (approval.sessionId !== undefined && approval.sessionId !== input.logicalSessionId)
  ) {
    return reject("invalid-approval");
  }
  const destination = deliveryDestination(approval);
  let merge: z.infer<typeof mergedSchema> | undefined;
  let waitingForChecks: string | undefined;
  let lastSchemaResult: z.infer<typeof repositoryProductionNativeStatusSchema> | undefined;
  for (const step of input.completedSteps) {
    if (step.afterStop === true) {
      return reject(unexpectedStepAfterStop);
    }
    const result = readStep(step, input, approval, report);
    if (result === null) {
      return false;
    }
    if (step.name === deliveryStep) {
      const delivery = deliveryOutputSchema.safeParse(result.output).data;
      if (delivery === undefined || merge !== undefined) {
        return reject("invalid-delivery-result");
      }
      if (result.argument !== waitingForChecks) {
        return reject("ready-cycle-mismatch");
      }
      if (delivery.status === "waiting-for-checks") {
        if (waitingForChecks !== undefined && delivery.readyAt !== waitingForChecks) {
          return reject("ready-cycle-mismatch");
        }
        waitingForChecks = delivery.readyAt;
      } else {
        if (
          (delivery.nativeProductionTarget !== undefined &&
            !isDeepStrictEqual(delivery.nativeProductionTarget, {
              ...destination,
              appId: input.appId,
            })) ||
          input.schemaChangeExpected !== (delivery.schemaActivation !== undefined)
        ) {
          return reject("merge-target-mismatch");
        }
        merge = delivery;
      }
      continue;
    }
    if (
      step.name !== schemaStep ||
      merge?.schemaActivation === undefined ||
      merge.nativeProductionTarget === undefined
    ) {
      return reject("unexpected-schema-step");
    }
    const continuingSchema =
      lastSchemaResult?.status === "pending" ||
      (lastSchemaResult?.status === "available" &&
        lastSchemaResult.requestedRevision === "awaiting-activation");
    if (
      (lastSchemaResult !== undefined && !continuingSchema) ||
      merge.schemaActivation.deliveryCallId !== input.callId ||
      !isDeepStrictEqual(result.argument, {
        ...merge.schemaActivation,
        mergeSha: merge.mergeCommitSha,
        reviewedHeadSha: approval.headSha,
      })
    ) {
      return reject("schema-activation-mismatch");
    }
    lastSchemaResult = repositoryProductionNativeStatusSchema.safeParse(result.output).data;
    if (lastSchemaResult === undefined) {
      return reject("invalid-schema-result");
    }
    if (
      lastSchemaResult.appId !== input.appId ||
      (lastSchemaResult.destination !== undefined &&
        !isDeepStrictEqual(lastSchemaResult.destination, destination))
    ) {
      return reject(schemaTargetMismatch);
    }
  }
  if (merge === undefined) {
    return reject("merge-result-missing");
  }
  if (!input.schemaChangeExpected) {
    return true;
  }
  if (lastSchemaResult?.status !== "available" || lastSchemaResult.requestedRevision !== "live") {
    return reject("schema-not-confirmed-live");
  }
  // The final protected read checks installed schema. The earlier provider-only
  // activation proof includes this marker and cannot attest to the installation.
  if (lastSchemaResult.deployment.requestedRevisionActive !== undefined) {
    return reject("schema-provider-only");
  }
  return isDeepStrictEqual(lastSchemaResult.destination, destination)
    ? true
    : reject(schemaTargetMismatch);
};

export interface PriorGitHubDeliveryProof {
  readonly deliveryCallId: string;
  readonly mergeIntentDigest: string;
  readonly mergeSha: string;
  readonly readyAt?: string;
}

/** Identify an earlier merge receipt to verify against committed session history and the journal. */
export const readSettledGitHubDeliveryRepeat = (
  input: DeliveryEffectEvidence,
  report?: ReportRejection,
): PriorGitHubDeliveryProof | null => {
  const reject = rejection(null, report);
  const approval = githubPrDeliveryApprovalSchema.safeParse(input.toolInput).data;
  const [mergeStep, ...schemaSteps] = input.completedSteps;
  if (!input.schemaChangeExpected) {
    return reject("repeat-schema-not-expected");
  }
  if (
    approval === undefined ||
    approval.reconciliationDigest !== undefined ||
    (approval.sessionId !== undefined && approval.sessionId !== input.logicalSessionId)
  ) {
    return reject("invalid-approval");
  }
  if (mergeStep?.name !== deliveryStep) {
    return reject("repeat-merge-step-missing");
  }
  if (mergeStep.afterStop === true) {
    return reject(unexpectedStepAfterStop);
  }
  const observedMerge = readStep(mergeStep, input, approval, report);
  if (observedMerge === null) {
    return null;
  }
  if (observedMerge.argument !== undefined) {
    return reject("repeat-merge-step-has-ready-cycle");
  }
  const merge = mergedSchema.safeParse(observedMerge.output).data;
  const destination = deliveryDestination(approval);
  if (merge === undefined) {
    return reject("invalid-delivery-result");
  }
  if (
    merge.schemaActivation === undefined ||
    merge.schemaActivation.deliveryCallId === input.callId
  ) {
    return reject("repeat-prior-call-missing");
  }
  if (!isDeepStrictEqual(merge.nativeProductionTarget, { ...destination, appId: input.appId })) {
    return reject("merge-target-mismatch");
  }
  const activation = {
    ...merge.schemaActivation,
    mergeSha: merge.mergeCommitSha,
    reviewedHeadSha: approval.headSha,
  };
  for (const [index, step] of schemaSteps.entries()) {
    // The earlier committed delivery must account for the only final schema
    // step admitted after Stop. A later step would be a new unresolved effect.
    const last = index === schemaSteps.length - 1;
    if (step.name !== schemaStep) {
      return reject("unexpected-schema-step");
    }
    if (step.afterStop === true && !last) {
      return reject(unexpectedStepAfterStop);
    }
    const args = readStepArguments(step, input, approval, report);
    if (args === null) {
      return null;
    }
    if (!isDeepStrictEqual(args[2], activation)) {
      return reject("schema-activation-mismatch");
    }
    if (step.status === "cancelled" || step.status === "failed") {
      if (!last) {
        return reject("unexpected-step-status");
      }
      if (step.output !== undefined) {
        return reject("repeat-terminal-step-has-output");
      }
      continue;
    }
    const result = readStep(step, input, approval, report);
    if (result === null) {
      return null;
    }
    const stopped = last && monitoringStoppedSchema.safeParse(result.output).success;
    if (!stopped) {
      const status = repositoryProductionNativeStatusSchema.safeParse(result.output).data;
      if (status === undefined) {
        return reject("invalid-schema-result");
      }
      if (status.appId !== input.appId || !isDeepStrictEqual(status.destination, destination)) {
        return reject(schemaTargetMismatch);
      }
      const waiting =
        status.requestedRevision === "awaiting-activation" &&
        (status.status === "pending" || status.status === "available");
      const live =
        last &&
        status.requestedRevision === "live" &&
        status.deployment.requestedRevisionActive === undefined;
      if (!waiting && !live) {
        return reject(
          last && status.requestedRevision === "live"
            ? "schema-provider-only"
            : "schema-not-confirmed-live",
        );
      }
    }
  }
  return approval.readyAt === undefined
    ? { ...merge.schemaActivation, mergeSha: merge.mergeCommitSha }
    : { ...merge.schemaActivation, mergeSha: merge.mergeCommitSha, readyAt: approval.readyAt };
};
