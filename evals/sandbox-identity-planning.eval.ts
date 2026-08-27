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
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send(
      `Accept build-ready AppSpec for builder-proof:\n${BUILD_READY_APP_SPEC}`,
    );
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.requireInputRequest({ toolName: "accept_app_spec" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Prepare offline target dependencies.");
    t.requireInputRequest({ toolName: "prepare_target_dependencies" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("target-bound offline dependency closure"));

    await t.send("Run target identity and planning.");
    t.requireInputRequest({ toolName: "plan_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("target identity and planning commands"));
    t.check(t.reply, includes("no apply, validation, or target mutation"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(t.reply, includes('"phase":"planned"'));

    t.calledTool("inspect_source", { count: 1 });
    t.calledTool("prepare_workspace", { count: 1 });
    t.calledTool("record_prototype_artifact", { count: 1 });
    t.calledTool("accept_app_spec", { count: 1 });
    t.calledTool("prepare_target_dependencies", { count: 1 });
    t.calledTool("plan_app_creation", { count: 1 });
    for (const tool of [
      "apply_app_creation",
      "validate_app_creation",
      "accept_change_set",
      "publish_reviewed_change_set",
      "publish_reviewed_change_set_to_branch_worktree",
      "prepare_fresh_template",
      "bash",
      "write_file",
    ])
      t.notCalledTool(tool);

    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        terminalPhase: "planned",
        calledTools: [
          "inspect_source",
          "prepare_workspace",
          "record_prototype_artifact",
          "accept_app_spec",
          "prepare_target_dependencies",
          "plan_app_creation",
          "artifact_workflow_status",
        ],
        forbiddenTools: [
          "apply_app_creation",
          "validate_app_creation",
          "accept_change_set",
          "publish_reviewed_change_set",
          "publish_reviewed_change_set_to_branch_worktree",
          "prepare_fresh_template",
          "bash",
          "write_file",
        ],
      })}\n`,
    );
  },
});
