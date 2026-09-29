import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A completed local publication is terminal and rejects prototype and AppSpec mutation.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "published-boundary");

    turn = await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();

    turn = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.check(turn.message, includes("durable state was not changed"));

    turn = await session.send("Attempt AppSpec mutation after publication.");
    t.succeeded();
    t.check(turn.message, includes("denied by the terminal publication workflow"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
