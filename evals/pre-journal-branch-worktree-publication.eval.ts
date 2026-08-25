import { execFileSync } from "node:child_process";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

export default defineEval({
  description:
    "A branch-worktree interruption before durable intent preserves the reviewed workflow and creates no branch.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "branch-publication-pre-journal-interruption",
    );

    await t.send("Publish reviewed change set to a new branch worktree.");
    t.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("reviewed receipt was preserved"));
    if (git(repository, ["branch", "--list", "app-builder/*"]).trim() !== "")
      throw new Error("Pre-journal interruption created a branch.");

    await t.send("Report artifact workflow status.");
    t.check(t.reply, includes('"phase":"reviewed"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
