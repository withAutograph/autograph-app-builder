import { execFileSync } from "node:child_process";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A stale branch-worktree proposal is rejected after approval without creating its branch or worktree.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "branch-publication-stale");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf-8",
    });
    await session.send("Publish reviewed change set with stale branch preconditions.");
    session.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn1.message, includes("rejected without creating a branch or worktree"));
    if (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf-8",
      }) !== head
    ) {
      throw new Error("A stale approval changed the source HEAD.");
    }
    if (
      execFileSync("git", ["branch", "--list", "app-builder/*"], {
        cwd: repository,
        encoding: "utf-8",
      }) !== ""
    ) {
      throw new Error("A stale approval created a branch.");
    }
    t.notCalledTool("recover_branch_worktree_publication");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
