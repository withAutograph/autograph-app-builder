import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable success written before workflow CAS is verified and terminalized without mutation redispatch.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "publication-success-recovery");
    turn = await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();

    turn = await session.send("Retry local publication after a lost response.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("reused the exact durable"));
    turn = await session.send("Report artifact workflow status.");
    t.check(turn.message, includes('"phase":"published_local"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
