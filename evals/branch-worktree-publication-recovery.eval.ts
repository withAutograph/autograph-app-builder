import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A partial branch-worktree apply is durable, never auto-retried, and requires a separate digest-bound recovery approval.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(
      t,
      repository,
      "branch-publication-partial-failure",
    );

    await session.send("Publish reviewed change set to a new branch worktree.");
    session.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn1.message, includes("recovery-required partial-failure receipt"));

    const turn2 = await session.send("Retry branch worktree publication after a lost response.");
    t.succeeded();
    t.check(turn2.message, includes("not redispatched automatically"));
    await session.send("Recover branch worktree publication.");
    session.requireInputRequest({ toolName: "recover_branch_worktree_publication" });
    const turn3 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn3.message, includes("separately approved recovery completed"));
    t.check(turn3.message, includes("without a commit, push, remote publication"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
