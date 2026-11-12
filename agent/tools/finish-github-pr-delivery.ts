import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";

import { githubPrDeliveryApprovalSchema } from "../../lib/agent/github-pr-delivery-approval";
import {
  approveGitHubPrDelivery,
  continueGitHubPrDelivery,
} from "../../lib/agent/github-pr-delivery-step";
import { observeMergedAppProductionStep } from "../../lib/agent/observe-app-production-step";

// After twenty minutes of durable waits, return the current observation so an older live
// deployment does not hold a merged turn open indefinitely. The saved release can be checked again.
const productionObservationRetries = 80;

export default defineWorkflowTool({
  approval: approveGitHubPrDelivery,
  availableInSubagents: false,
  description:
    "After managed Production setup, mark the reviewed pull request ready and merge that exact revision once required checks pass. A matching Production release approval covers these effects. Otherwise ask for the ordinary approval. Pass the approval returned by read_github_pr_delivery. Before merge, Builder independently checks required setup for this exact app and repository; follow production-setup-required through its existing normal setup tools. After merge, observe whether the provider activates this merge commit at the owned native app entry. Existing app availability is reported separately while the update activates. Native activation and authenticated behavior have separate results.",
  inputSchema: githubPrDeliveryApprovalSchema,
  async *execute(input, ctx) {
    "use workflow";
    let result = await continueGitHubPrDelivery(input, ctx);
    while (result.status === "waiting-for-checks") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while GitHub runs the required checks.
      await sleep("15s");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Resume the same approved intent and ready cycle.
      result = await continueGitHubPrDelivery(input, ctx, result.readyAt);
    }
    if (result.status !== "merged") {
      return result;
    }
    const { nativeProductionTarget, ...merged } = result;
    if (nativeProductionTarget === undefined) {
      return merged;
    }
    yield merged;
    let nativeProduction = await observeMergedAppProductionStep(
      nativeProductionTarget,
      ctx,
      merged.mergeCommitSha,
    );
    let availableUrl =
      nativeProduction.status === "available" ? nativeProduction.app.url : undefined;
    for (
      let retry = 0;
      retry < productionObservationRetries &&
      (nativeProduction.status === "pending" ||
        (nativeProduction.status === "available" &&
          nativeProduction.requestedRevision === "awaiting-activation"));
      retry += 1
    ) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Provider-owned activation is observed after merge without holding compute.
      await sleep("15s");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck the same captured app/destination after each wait.
      nativeProduction = await observeMergedAppProductionStep(
        nativeProductionTarget,
        ctx,
        merged.mergeCommitSha,
      );
      if (nativeProduction.status === "available") {
        availableUrl = nativeProduction.app.url ?? availableUrl;
      }
    }
    if (
      nativeProduction.status === "service-unavailable" &&
      availableUrl !== undefined &&
      nativeProduction.app.url === undefined
    ) {
      nativeProduction = {
        ...nativeProduction,
        app: { ...nativeProduction.app, url: availableUrl },
      };
    }
    return { ...merged, nativeProduction };
  },
});
