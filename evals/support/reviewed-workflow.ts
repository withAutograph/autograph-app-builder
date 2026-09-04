import type { EveEvalContext } from "eve/evals";

import { BUILD_READY_APP_SPEC } from "./app-spec";

export async function prepareReviewedWorkflow(
  t: EveEvalContext,
  repository: string,
  appId: string,
  sourceKind: "existing-repository" | "fresh-template" = "existing-repository",
): Promise<void> {
  await t.send(
    sourceKind === "fresh-template"
      ? `Prepare fresh template at ${repository}`
      : `Prepare supported repository at ${repository}`,
  );
  await t.send(
    `Accept build-ready AppSpec for ${appId}:\n${BUILD_READY_APP_SPEC}`,
  );

  await t.send("Prepare offline target dependencies.");

  await t.send("Run target identity and planning.");

  await t.send("Apply the current creation proposal.");
  // Keep this helper compatible with the installed Eve eval surface: the
  // pending request list is the stable context-level contract.
  if (
    t.pendingInputRequests.length !== 1 ||
    t.pendingInputRequests[0]?.toolName !== "apply_app_creation"
  ) {
    throw new Error("Expected one apply_app_creation approval request.");
  }
  await t.respondAll("approve");

  const validation = await t.send("Validate the applied creation.");
  validation.notEvent("input.requested");

  await t.send("Inspect the validated change set.");
  t.succeeded();

  const review = await t.send("Accept the displayed change set.");
  review.notEvent("input.requested");
  t.succeeded();
}
