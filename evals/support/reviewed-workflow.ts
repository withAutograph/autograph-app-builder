import type { EveEvalContext, EveEvalSession, EveEvalTurn } from "eve/evals";

import { BUILD_READY_APP_SPEC } from "./app-spec";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function prepareReviewedWorkflow(
  t: EveEvalContext,
  repository: string,
  appId: string,
  sourceKind: "existing-repository" | "fresh-template" = "existing-repository",
): Promise<EveEvalSession> {
  const session = await t.session();
  let turn: EveEvalTurn;
  turn = await session.send(
    sourceKind === "fresh-template"
      ? `Prepare fresh template at ${repository}`
      : `Prepare supported repository at ${repository}`,
  );
  turn = await session.send(`Accept build-ready AppSpec for ${appId}:\n${BUILD_READY_APP_SPEC}`);

  turn = await session.send("Prepare offline target dependencies.");

  turn = await session.send("Run target identity and planning.");

  turn = await session.send("Apply the current creation proposal.");
  session.requireInputRequest({ toolName: "apply_app_creation" });
  turn = await session.respondAll("approve");

  const validation = (turn = await session.send("Validate the applied creation."));
  validation.notEvent("input.requested");

  turn = await session.send("Inspect the validated change set.");
  t.succeeded();

  const review = (turn = await session.send("Accept the displayed change set."));
  review.notEvent("input.requested");
  t.succeeded();
  return session;
}
