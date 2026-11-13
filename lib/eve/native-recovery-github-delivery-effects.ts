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
) => {
  const [wrapper] = stepArgumentsSchema.safeParse(step.args).data ?? [];
  if (
    wrapper === undefined ||
    wrapper.context.callId !== input.callId ||
    wrapper.context.session.id !== input.logicalSessionId ||
    !isDeepStrictEqual(wrapper.args[0], approval)
  ) {
    return null;
  }
  return wrapper.args;
};

const readStep = (
  step: CompletedDeliveryStep,
  input: DeliveryEffectEvidence,
  approval: Approval,
) => {
  if (step.status !== undefined && step.status !== "completed") {
    return null;
  }
  const args = readStepArguments(step, input, approval);
  const result = stepOutputSchema.safeParse(step.output).data;
  return args === null || result === undefined
    ? null
    : { argument: args[2], output: result.output };
};

const deliveryDestination = (approval: Approval) => ({
  repositoryId: approval.repositoryId,
  repositoryFullName: `${approval.owner}/${approval.name}`,
});

/** Check the retained writes of a natively bound child without creating a tool result or replay authority. */
export const hasSettledGitHubDeliveryEffects = (input: DeliveryEffectEvidence): boolean => {
  const approval = githubPrDeliveryApprovalSchema.safeParse(input.toolInput).data;
  if (
    approval === undefined ||
    (approval.sessionId !== undefined && approval.sessionId !== input.logicalSessionId)
  ) {
    return false;
  }
  const destination = deliveryDestination(approval);
  let merge: z.infer<typeof mergedSchema> | undefined;
  let waitingForChecks: string | undefined;
  let lastSchemaResult: z.infer<typeof repositoryProductionNativeStatusSchema> | undefined;
  for (const step of input.completedSteps) {
    if (step.afterStop === true) {
      return false;
    }
    const result = readStep(step, input, approval);
    if (result === null) {
      return false;
    }
    if (step.name === deliveryStep) {
      const delivery = deliveryOutputSchema.safeParse(result.output).data;
      if (delivery === undefined || merge !== undefined || result.argument !== waitingForChecks) {
        return false;
      }
      if (delivery.status === "waiting-for-checks") {
        if (waitingForChecks !== undefined && delivery.readyAt !== waitingForChecks) {
          return false;
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
          return false;
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
      return false;
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
      return false;
    }
    lastSchemaResult = repositoryProductionNativeStatusSchema.safeParse(result.output).data;
    if (
      lastSchemaResult?.appId !== input.appId ||
      (lastSchemaResult.destination !== undefined &&
        !isDeepStrictEqual(lastSchemaResult.destination, destination))
    ) {
      return false;
    }
  }
  if (merge === undefined || !input.schemaChangeExpected) {
    return merge !== undefined;
  }
  if (lastSchemaResult?.status !== "available" || lastSchemaResult.requestedRevision !== "live") {
    return false;
  }
  // The final protected read checks installed schema. The earlier provider-only
  // activation proof includes this marker and cannot attest to the installation.
  return (
    lastSchemaResult.deployment.requestedRevisionActive === undefined &&
    isDeepStrictEqual(lastSchemaResult.destination, destination)
  );
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
): PriorGitHubDeliveryProof | null => {
  const approval = githubPrDeliveryApprovalSchema.safeParse(input.toolInput).data;
  const [mergeStep, ...schemaSteps] = input.completedSteps;
  if (
    !input.schemaChangeExpected ||
    approval === undefined ||
    mergeStep?.name !== deliveryStep ||
    mergeStep.afterStop === true
  ) {
    return null;
  }
  if (
    approval.reconciliationDigest !== undefined ||
    (approval.sessionId !== undefined && approval.sessionId !== input.logicalSessionId)
  ) {
    return null;
  }
  const observedMerge = readStep(mergeStep, input, approval);
  if (observedMerge === null || observedMerge.argument !== undefined) {
    return null;
  }
  const merge = mergedSchema.safeParse(observedMerge.output).data;
  const destination = deliveryDestination(approval);
  if (
    merge?.schemaActivation === undefined ||
    merge.schemaActivation.deliveryCallId === input.callId ||
    !isDeepStrictEqual(merge.nativeProductionTarget, { ...destination, appId: input.appId })
  ) {
    return null;
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
    const args = readStepArguments(step, input, approval);
    if (
      step.name !== schemaStep ||
      (step.afterStop === true && !last) ||
      !isDeepStrictEqual(args?.[2], activation)
    ) {
      return null;
    }
    if (step.status === "cancelled" || step.status === "failed") {
      if (!last || step.output !== undefined) {
        return null;
      }
      continue;
    }
    const result = readStep(step, input, approval);
    const stopped = last && monitoringStoppedSchema.safeParse(result?.output).success;
    if (!stopped) {
      const status = repositoryProductionNativeStatusSchema.safeParse(result?.output).data;
      if (status?.appId !== input.appId || !isDeepStrictEqual(status.destination, destination)) {
        return null;
      }
      const waiting =
        status.requestedRevision === "awaiting-activation" &&
        (status.status === "pending" || status.status === "available");
      const live =
        last &&
        status.requestedRevision === "live" &&
        status.deployment.requestedRevisionActive === undefined;
      if (!waiting && !live) {
        return null;
      }
    }
  }
  return approval.readyAt === undefined
    ? { ...merge.schemaActivation, mergeSha: merge.mergeCommitSha }
    : { ...merge.schemaActivation, mergeSha: merge.mergeCommitSha, readyAt: approval.readyAt };
};
