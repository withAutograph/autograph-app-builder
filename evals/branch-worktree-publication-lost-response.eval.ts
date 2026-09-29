import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A lost response after branch-worktree side effects is read back from durable intent and recovered without creating a second identity.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(
      t,
      repository,
      "branch-publication-lost-response",
    );
    await session.send("Publish reviewed change set to a new branch worktree.");
    session.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn1.message, includes("recovery-required"));

    await session.send("Recover branch worktree publication.");
    session.requireInputRequest({ toolName: "recover_branch_worktree_publication" });
    const turn2 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn2.message, includes("separately approved recovery completed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
