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
  t.notEvent("input.requested");

  await t.send("Validate the applied creation.");
  t.notEvent("input.requested");

  await t.send("Inspect the validated change set.");
  t.succeeded();

  await t.send("Accept the displayed change set.");
  t.notEvent("input.requested");
  t.succeeded();
}
