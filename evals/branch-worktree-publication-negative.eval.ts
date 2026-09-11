import { execFileSync } from "node:child_process";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A canceled branch-worktree approval creates no branch, worktree, commit, push, or target mutation.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(t, repository, "branch-publication-cancel");
    await t.send("Publish reviewed change set to a new branch worktree.");
    t.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    await t.respondAll("cancel");
    t.succeeded();
    t.check(t.reply, includes("canceled or rejected"));
    if (
      execFileSync("git", ["branch", "--list", "app-builder/*"], {
        cwd: repository,
        encoding: "utf8",
      }) !== ""
    )
      throw new Error("A canceled approval created a branch.");

    t.notCalledTool("recover_branch_worktree_publication");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
