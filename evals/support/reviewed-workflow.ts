import type { EveEvalContext, EveEvalSession } from "eve/evals";

import { BUILD_READY_APP_SPEC } from "./app-spec";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function prepareReviewedWorkflow(
  t: EveEvalContext,
  repository: string,
  appId: string,
  sourceKind: "existing-repository" | "fresh-template" = "existing-repository",
): Promise<EveEvalSession> {
  const session = await t.session();
  await session.send(
    sourceKind === "fresh-template"
      ? `Prepare fresh template at ${repository}`
      : `Prepare supported repository at ${repository}`,
  );
  await session.send(`Accept build-ready AppSpec for ${appId}:\n${BUILD_READY_APP_SPEC}`);

  await session.send("Prepare offline target dependencies.");

  await session.send("Run target identity and planning.");

  await session.send("Apply the current creation proposal.");
  session.requireInputRequest({ toolName: "apply_app_creation" });
  await session.respondAll("approve");

  const validation = await session.send("Validate the applied creation.");
  validation.notEvent("input.requested");

  await session.send("Inspect the validated change set.");
  t.succeeded();

  const review = await session.send("Accept the displayed change set.");
  review.notEvent("input.requested");
  t.succeeded();
  return session;
}
