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
  if (sourceKind === "fresh-template") {
    t.requireInputRequest({ toolName: "approve_source_acquisition" });
    await t.respondAll("approve");
  }
  t.requireInputRequest({ toolName: "prepare_workspace" });
  await t.respondAll("approve");

  await t.send(
    `Accept build-ready AppSpec for ${appId}:\n${BUILD_READY_APP_SPEC}`,
  );
  t.requireInputRequest({ toolName: "record_prototype_artifact" });
  await t.respondAll("approve");
  t.requireInputRequest({ toolName: "accept_app_spec" });
  await t.respondAll("approve");

  await t.send("Prepare offline target dependencies.");
  t.requireInputRequest({ toolName: "prepare_target_dependencies" });
  await t.respondAll("approve");

  await t.send("Run target identity and planning.");
  t.requireInputRequest({ toolName: "plan_app_creation" });
  await t.respondAll("approve");

  await t.send("Apply the current creation proposal.");
  t.requireInputRequest({ toolName: "apply_app_creation" });
  await t.respondAll("approve");

  await t.send("Validate the applied creation.");
  t.requireInputRequest({ toolName: "validate_app_creation" });
  await t.respondAll("approve");

  await t.send("Inspect the validated change set.");
  t.succeeded();

  await t.send("Accept the displayed change set.");
  t.requireInputRequest({ toolName: "accept_change_set" });
  await t.respondAll("approve");
  t.succeeded();
}
