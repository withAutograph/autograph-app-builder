import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A partial branch-worktree apply is durable, never auto-retried, and requires a separate digest-bound recovery approval.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(
      t,
      repository,
      "branch-publication-partial-failure",
    );

    turn = await session.send("Publish reviewed change set to a new branch worktree.");
    session.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("recovery-required partial-failure receipt"));

    turn = await session.send("Retry branch worktree publication after a lost response.");
    t.succeeded();
    t.check(turn.message, includes("not redispatched automatically"));
    turn = await session.send("Recover branch worktree publication.");
    session.requireInputRequest({ toolName: "recover_branch_worktree_publication" });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("separately approved recovery completed"));
    t.check(turn.message, includes("without a commit, push, remote publication"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
