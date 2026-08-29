import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { isProductFacing } from "./support/public-conversation";

const staysProductFacing = satisfies(
  (reply) =>
    isProductFacing(reply) &&
    !/(?:builder-owned|overlay|fixed check|normalized change set|approval receipt|publication did not run)/iu.test(
      String(reply),
    ),
  "assistant reply stays product-facing and omits internal review mechanics",
);

export default defineEval({
  description:
    "The exact digest sandbox applies and validates one supported-source proposal, then records the reviewed change set without publication.",
  tags: ["sandbox-image-proof", "reviewed-change-set"],
  timeoutMs: 360_000,
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The signed sandbox proof source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send(
      `Accept build-ready AppSpec for builder-reviewed-proof:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();

    await t.send("Prepare offline target dependencies.");
    t.succeeded();

    await t.send("Run target identity and planning.");
    t.succeeded();

    await t.send("Apply the current creation proposal.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("private preview"));
    t.check(t.reply, staysProductFacing);

    await t.send("Validate the applied creation.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("quality checks"));
    t.check(t.reply, staysProductFacing);

    await t.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });

    await t.send("Accept the displayed change set.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("ready for review"));
    t.check(t.reply, includes("Nothing has been published"));
    t.check(t.reply, staysProductFacing);

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(t.reply, includes('"phase":"reviewed"'));

    for (const tool of [
      "publish_reviewed_change_set",
      "publish_reviewed_change_set_to_branch_worktree",
      "publish_fresh_repository",
      "publish_github_change_set",
      "bash",
      "write_file",
    ])
      t.notCalledTool(tool);

    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        terminalPhase: "reviewed",
        sourceKind: "supported-existing-repository",
        publicationAttempted: false,
        requiredTools: [
          "inspect_source",
          "prepare_workspace",
          "record_prototype_artifact",
          "accept_app_spec",
          "prepare_target_dependencies",
          "plan_app_creation",
          "apply_app_creation",
          "validate_app_creation",
          "change_set_status",
          "accept_change_set",
          "artifact_workflow_status",
        ],
      })}\n`,
    );
  },
});
