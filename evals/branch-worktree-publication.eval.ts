import { execFileSync } from "node:child_process";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

export default defineEval({
  description:
    "A separate approval creates only a deterministic uncommitted branch worktree and preserves the exact source checkout.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(t, repository, "branch-publication-success");
    const beforeHead = git(repository, ["rev-parse", "HEAD"]);
    const beforeStatus = git(repository, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
    ]);

    await t.send("Publish reviewed change set to a new branch worktree.");
    t.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("new deterministic branch worktree"));
    t.check(t.reply, includes("no commit, push, GitHub, provider"));
    if (git(repository, ["rev-parse", "HEAD"]) !== beforeHead)
      throw new Error("The original checkout HEAD changed.");
    if (
      git(repository, ["status", "--porcelain=v2", "--untracked-files=all"]) !==
      beforeStatus
    )
      throw new Error("The original checkout status changed.");
    t.check(
      git(repository, ["branch", "--list", "app-builder/*"]),
      includes("app-builder/review-"),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
