import { execFileSync } from "node:child_process";

import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A canceled branch-worktree approval creates no branch, worktree, commit, push, or target mutation.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "branch-publication-cancel");
    turn = await session.send("Publish reviewed change set to a new branch worktree.");
    session.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    turn = await session.respondAll("cancel");
    t.succeeded();
    t.check(turn.message, includes("canceled or rejected"));
    if (
      execFileSync("git", ["branch", "--list", "app-builder/*"], {
        cwd: repository,
        encoding: "utf-8",
      }) !== ""
    ) {
      throw new Error("A canceled approval created a branch.");
    }

    t.notCalledTool("recover_branch_worktree_publication");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
