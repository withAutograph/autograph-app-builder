import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable pending local publication is never redispatched and blocks every upstream mutation.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "publication-interruption");

    turn = await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, includes('"phase":"publication_pending"'));

    turn = await session.send("Retry local publication after a lost response.");
    t.succeeded();
    t.check(turn.message, includes("not redispatched automatically"));

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, includes('"phase":"publication_pending"'));

    turn = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.check(turn.message, includes("durable state was not changed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
