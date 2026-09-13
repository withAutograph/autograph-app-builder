import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { isProductFacing } from "./support/public-conversation";

const staysProductFacing = satisfies(
  (reply) =>
    isProductFacing(reply) &&
    !/(?:builder-owned|overlay|fixed check|normalized change set|approval receipt|publication did not run|nothing (?:has been|was) published)/iu.test(
      String(reply),
    ),
  "assistant reply stays product-facing and omits internal review mechanics",
);

export default defineEval({
  description:
    "The exact digest sandbox applies and validates one supported-source proposal, then records the reviewed change set without publication.",
  tags: ["sandbox-image-proof", "reviewed-change-set"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The signed sandbox proof source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send(`Accept build-ready AppSpec for builder-reviewed-proof:\n${BUILD_READY_APP_SPEC}`);
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
    t.calledTool("change-set-status", { count: 1 });

    await t.send("Accept the displayed change set.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("ready for review"));
    t.check(t.reply, includes("draft pull request"));
    t.check(t.reply, staysProductFacing);

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact-workflow-status", { count: 1 });
    t.check(t.reply, includes('"phase":"reviewed"'));

    for (const tool of [
      "publish-reviewed-change-set",
      "publish-reviewed-change-set_to_branch_worktree",
      "publish-fresh-repository",
      "publish_github_change_set",
      "bash",
      "write-file",
    ])
      t.notCalledTool(tool);

    process.stdout.write(
      `${JSON.stringify({
        browserPreview: true,
        publicationAttempted: false,
        requiredTools: [
          "inspect-source",
          "prepare-workspace",
          "record-prototype-artifact",
          "accept-app-spec",
          "prepare-target-dependencies",
          "plan-app-creation",
          "apply-app-creation",
          "validate-app-creation",
          "change-set-status",
          "accept-change-set",
          "artifact-workflow-status",
        ],
        sourceKind: "supported-existing-repository",
        terminalPhase: "reviewed",
        version: 1,
      })}\n`,
    );
  },
  timeoutMs: 360_000,
});
