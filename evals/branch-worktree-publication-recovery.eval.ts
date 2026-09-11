import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A partial branch-worktree apply is durable, never auto-retried, and requires a separate digest-bound recovery approval.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "branch-publication-partial-failure",
    );

    await t.send("Publish reviewed change set to a new branch worktree.");
    t.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("recovery-required partial-failure receipt"));

    await t.send("Retry branch worktree publication after a lost response.");
    t.succeeded();
    t.check(t.reply, includes("not redispatched automatically"));
    await t.send("Recover branch worktree publication.");
    t.requireInputRequest({ toolName: "recover_branch_worktree_publication" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("separately approved recovery completed"));
    t.check(t.reply, includes("without a commit, push, remote publication"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
