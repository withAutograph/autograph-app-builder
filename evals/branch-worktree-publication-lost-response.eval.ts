import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A lost response after branch-worktree side effects is read back from durable intent and recovered without creating a second identity.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "branch-publication-lost-response",
    );
    await t.send("Publish reviewed change set to a new branch worktree.");
    t.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("recovery-required"));

    await t.send("Recover branch worktree publication.");
    t.requireInputRequest({ toolName: "recover_branch_worktree_publication" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("separately approved recovery completed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
