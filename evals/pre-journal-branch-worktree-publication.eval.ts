import { execFileSync } from "node:child_process";

import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" });

export default defineEval({
  description:
    "A branch-worktree interruption before durable intent preserves the reviewed workflow and creates no branch.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "branch-publication-pre-journal-interruption");

    turn = await session.send("Publish reviewed change set to a new branch worktree.");
    session.requireInputRequest({
      toolName: "publish_reviewed_change_set_to_branch_worktree",
    });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("reviewed receipt was preserved"));
    if (git(repository, ["branch", "--list", "app-builder/*"]).trim() !== "") {
      throw new Error("Pre-journal interruption created a branch.");
    }

    turn = await session.send("Report artifact workflow status.");
    t.check(turn.message, includes('"phase":"reviewed"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
