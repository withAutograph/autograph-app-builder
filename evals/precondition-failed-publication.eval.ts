import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A pre-journal precondition failure remains readable without a forged durable journal.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(
      t,
      repository,
      "publication-precondition-failure",
    );
    turn = await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();

    turn = await session.send("Retry local publication after a lost response.");
    t.succeeded();
    t.check(turn.message, includes("not redispatched automatically"));
    turn = await session.send("Report artifact workflow status.");
    t.check(turn.message, includes('"phase":"publication_failed"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
