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
const stepOutputSchema = z.strictObject({
  kind: z.literal("result"),
  output: z.unknown(),
  authorized: z.tuple([]),
});

interface CompletedDeliveryStep {
  readonly name: string;
  readonly args: unknown;
  readonly output: unknown;
}

interface DeliveryEffectEvidence {
  readonly callId: string;
  readonly logicalSessionId: string;
  readonly appId: string;
  readonly toolInput: unknown;
  readonly schemaChangeExpected: boolean;
  readonly completedSteps: readonly CompletedDeliveryStep[];
}

const readStep = (
  step: CompletedDeliveryStep,
  input: DeliveryEffectEvidence,
  approval: z.infer<typeof githubPrDeliveryApprovalSchema>,
) => {
  const [wrapper] = stepArgumentsSchema.safeParse(step.args).data ?? [];
  const result = stepOutputSchema.safeParse(step.output).data;
  if (wrapper === undefined || result === undefined) {
    return null;
  }
  if (
    wrapper.context.callId !== input.callId ||
    wrapper.context.session.id !== input.logicalSessionId ||
    !isDeepStrictEqual(wrapper.args[0], approval)
  ) {
    return null;
  }
  return { argument: wrapper.args[2], output: result.output };
};

/** Check the retained writes of a natively bound child without creating a tool result or replay authority. */
export const hasSettledGitHubDeliveryEffects = (input: DeliveryEffectEvidence): boolean => {
  const approval = githubPrDeliveryApprovalSchema.safeParse(input.toolInput).data;
  if (
    approval === undefined ||
    (approval.sessionId !== undefined && approval.sessionId !== input.logicalSessionId)
  ) {
    return false;
  }
  const destination = {
    repositoryId: approval.repositoryId,
    repositoryFullName: `${approval.owner}/${approval.name}`,
  };
  let merge: z.infer<typeof mergedSchema> | undefined;
  let waitingForChecks: string | undefined;
  let lastSchemaResult: z.infer<typeof repositoryProductionNativeStatusSchema> | undefined;
  for (const step of input.completedSteps) {
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
