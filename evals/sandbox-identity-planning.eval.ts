import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";

export default defineEval({
  description:
    "The exact digest sandbox prepares the supported source and reaches only the typed planned phase.",
  tags: ["sandbox-image-proof"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The signed sandbox proof source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send(`Accept build-ready AppSpec for builder-proof:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();

    await t.send("Prepare offline target dependencies.");
    t.succeeded();
    t.check(t.reply, includes("target-bound offline dependency closure"));

    await t.send("Run target identity and planning.");
    t.succeeded();
    t.check(t.reply, includes("target identity and planning commands"));
    t.check(t.reply, includes("no apply, validation, or target mutation"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact-workflow-status", { count: 1 });
    t.check(t.reply, includes('"phase":"planned"'));

    t.calledTool("inspect-source", { count: 1 });
    t.calledTool("prepare-workspace", { count: 1 });
    t.calledTool("record-prototype-artifact", { count: 1 });
    t.calledTool("accept-app-spec", { count: 1 });
    t.calledTool("prepare-target-dependencies", { count: 1 });
    t.calledTool("plan-app-creation", { count: 1 });
    for (const tool of [
      "apply-app-creation",
      "validate-app-creation",
      "accept-change-set",
      "publish-reviewed-change-set",
      "publish-reviewed-change-set_to_branch_worktree",
      "prepare_fresh_template",
      "bash",
      "write-file",
    ])
      t.notCalledTool(tool);

    process.stdout.write(
      `${JSON.stringify({
        calledTools: [
          "inspect-source",
          "prepare-workspace",
          "record-prototype-artifact",
          "accept-app-spec",
          "prepare-target-dependencies",
          "plan-app-creation",
          "artifact-workflow-status",
        ],
        forbiddenTools: [
          "apply-app-creation",
          "validate-app-creation",
          "accept-change-set",
          "publish-reviewed-change-set",
          "publish-reviewed-change-set_to_branch_worktree",
          "prepare_fresh_template",
          "bash",
          "write-file",
        ],
        terminalPhase: "planned",
        version: 1,
      })}\n`,
    );
  },
});
