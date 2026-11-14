import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";

import { githubPrDeliveryApprovalSchema } from "../../lib/agent/github-pr-delivery-approval";
import {
  approveGitHubPrDelivery,
  continueGitHubPrDelivery,
  continueGitHubProductionSchema,
} from "../../lib/agent/github-pr-delivery-step";
import { observeMergedAppProductionStep } from "../../lib/agent/observe-app-production-step";
import type { AppProductionObservation } from "../../lib/agent/app-production-observation";
import type { DeliveryProgress } from "../../lib/delivery-progress";

// After twenty minutes of durable waits, return the current observation so an older live
// deployment does not hold a merged turn open indefinitely. The saved release can be checked again.
const productionObservationRetries = 80;
const monitoringStopped = "monitoring-stopped";
const interventionRequired = "intervention-required";
const updatingData = "updating-data";
const serviceUnavailable = "service-unavailable";

const unfinishedDeployment = (observation: AppProductionObservation) =>
  observation.status === "pending" ||
  (observation.status === "available" && observation.requestedRevision === "awaiting-activation");

const retryableObservation = (observation: AppProductionObservation) =>
  observation.status === serviceUnavailable &&
  (observation.serviceIssue === "provider-read" || observation.serviceIssue === "gateway-read");

const shouldCheckAgain = (observation: AppProductionObservation) =>
  observation.status !== monitoringStopped &&
  (unfinishedDeployment(observation) || retryableObservation(observation)) &&
  observation.schemaUpdateDisposition !== interventionRequired;

const observedAppUrl = (observation: AppProductionObservation): string | undefined =>
  observation.status !== monitoringStopped &&
  (observation.app.state === "responding" || observation.app.state === "sign-in-required")
    ? observation.app.url
    : undefined;

const nativeDeliveryStage = (
  observation: AppProductionObservation,
  current: DeliveryProgress,
): DeliveryProgress => {
  if (observation.status === monitoringStopped) {
    const stopped: DeliveryProgress = { ...current, disposition: interventionRequired };
    delete stopped.appUrl;
    return stopped;
  }
  const { observedAt } = observation;
  let phase: DeliveryProgress["phase"] = "deploying";
  if (observation.requestedRevision === "live") {
    phase = "live";
  } else if (
    observation.deployment.requestedRevisionActive === true ||
    current.phase === updatingData
  ) {
    phase = updatingData;
  }
  let providerDisposition: DeliveryProgress["disposition"] = "active";
  if (observation.status === serviceUnavailable) {
    providerDisposition = retryableObservation(observation) ? "retrying" : interventionRequired;
  }
  const disposition = observation.schemaUpdateDisposition ?? providerDisposition;
  const next = {
    phase,
    disposition,
    observedAt,
    startedAt: phase === current.phase ? current.startedAt : observedAt,
    appUrl: observedAppUrl(observation) ?? current.appUrl,
  } satisfies DeliveryProgress;
  return next;
};

export default defineWorkflowTool({
  approval: approveGitHubPrDelivery,
  availableInSubagents: false,
  description:
    "After managed Production setup, mark the reviewed pull request ready and merge that exact revision once required checks pass. A matching Production release approval covers these effects. Otherwise ask for the ordinary approval. Pass the approval returned by read_github_pr_delivery. Before merge, Builder verifies required setup or an eligible optional schema addition for the exact reviewed app. Follow production-setup-required through its normal setup tools. Builder applies an approved optional field to the existing database after provider activation. After merge, observe whether the provider activates this merge commit at the owned native app entry. Existing app availability is reported separately while the update activates. Native activation and authenticated behavior have separate results.",
  inputSchema: githubPrDeliveryApprovalSchema,
  async *execute(input, ctx) {
    "use workflow";
    let result = await continueGitHubPrDelivery(input, ctx);
    let checkProgress: DeliveryProgress | undefined;
    while (result.status === "waiting-for-checks") {
      if (checkProgress === undefined && "nativeProductionPending" in result) {
        checkProgress = {
          phase: "waiting-for-checks",
          disposition: "active",
          startedAt: result.readyAt,
          observedAt: result.deliveryObservedAt ?? result.readyAt,
          appUrl: "currentAppUrl" in result ? result.currentAppUrl : undefined,
        };
        yield { deliveryProgress: checkProgress };
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while GitHub runs the required checks.
      await sleep("15s");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Resume the same approved intent and ready cycle.
      result = await continueGitHubPrDelivery(input, ctx, result.readyAt);
    }
    const { deliveryObservedAt, ...deliveryResult } = result;
    if (deliveryResult.status !== "merged") {
      if (checkProgress !== undefined) {
        return {
          ...deliveryResult,
          deliveryProgress: {
            ...checkProgress,
            disposition: interventionRequired,
            observedAt: deliveryObservedAt ?? checkProgress.observedAt,
          },
        };
      }
      return deliveryResult;
    }
    const { nativeProductionTarget, schemaActivation, ...merged } = deliveryResult;
    if (nativeProductionTarget === undefined) {
      return merged;
    }
    let deliveryProgress: DeliveryProgress | undefined =
      deliveryObservedAt === undefined
        ? undefined
        : {
            phase: "deploying",
            disposition: "active",
            startedAt: deliveryObservedAt,
            observedAt: deliveryObservedAt,
            appUrl: checkProgress?.appUrl,
          };
    yield deliveryProgress === undefined ? merged : { ...merged, deliveryProgress };
    let preparingSchema = false;
    const observe = async () => {
      if (schemaActivation === undefined) {
        return await observeMergedAppProductionStep(
          nativeProductionTarget,
          ctx,
          merged.mergeCommitSha,
        );
      }
      const activation = {
        ...schemaActivation,
        mergeSha: merged.mergeCommitSha,
        reviewedHeadSha: input.headSha,
      };
      return preparingSchema
        ? await continueGitHubProductionSchema(input, ctx, activation)
        : await continueGitHubProductionSchema(input, ctx, activation, true);
    };
    let nativeProduction = await observe();
    let availableUrl = observedAppUrl(nativeProduction);
    for (
      let retry = 0;
      retry < productionObservationRetries && shouldCheckAgain(nativeProduction);
      retry += 1
    ) {
      const startedSchema =
        !preparingSchema &&
        nativeProduction.status !== monitoringStopped &&
        nativeProduction.deployment.requestedRevisionActive === true;
      if (deliveryProgress !== undefined) {
        const next = nativeDeliveryStage(nativeProduction, deliveryProgress);
        if (
          next.phase !== deliveryProgress.phase ||
          next.disposition !== deliveryProgress.disposition ||
          next.appUrl !== deliveryProgress.appUrl
        ) {
          yield { deliveryProgress: next };
        }
        deliveryProgress = next;
      }
      if (startedSchema) {
        preparingSchema = true;
      } else {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The provider owns activation; observe it through durable waits.
        await sleep("15s");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck the same captured app/destination after each wait.
      nativeProduction = await observe();
      availableUrl = observedAppUrl(nativeProduction) ?? availableUrl;
    }
    if (
      nativeProduction.status === serviceUnavailable &&
      availableUrl !== undefined &&
      nativeProduction.app.url === undefined
    ) {
      nativeProduction = {
        ...nativeProduction,
        app: { ...nativeProduction.app, url: availableUrl },
      };
    }
    const schemaUpdatePending =
      schemaActivation !== undefined &&
      nativeProduction.status !== monitoringStopped &&
      nativeProduction.requestedRevision !== "live";
    const outcome = schemaUpdatePending
      ? { ...merged, nativeProduction, schemaUpdatePending }
      : { ...merged, nativeProduction };
    if (deliveryProgress === undefined) {
      return outcome;
    }
    const settledStage = nativeDeliveryStage(nativeProduction, deliveryProgress);
    return { ...outcome, deliveryProgress: settledStage };
  },
});
