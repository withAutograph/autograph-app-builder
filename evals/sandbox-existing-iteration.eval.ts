import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { isProductFacing } from "./support/public-conversation";

const staysProductFacing = satisfies(
  (reply) =>
    isProductFacing(reply) &&
    !/(?:sandbox|image|receipt|dependency cache|publication did not run)/iu.test(
      String(reply),
    ),
  "assistant reply stays product-facing during existing-app iteration",
);

export default defineEval({
  description:
    "The exact candidate image inspects and iterates the existing Vendor application through review without publication.",
  tags: ["sandbox-image-proof", "existing-app-iteration"],
  timeoutMs: 360_000,
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The signed sandbox proof source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();
    await t.send(
      `Accept build-ready AppSpec for vendor:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();
    await t.send("Inspect existing Vendor application.");
    t.succeeded();
    t.calledTool("inspect_existing_app", { count: 2 });
    await t.send("Prepare offline target dependencies.");
    t.succeeded();
    await t.send(
      "Update the Vendor review so operations can see when tax verification is required.",
    );
    t.succeeded();
    await t.send("Run target identity and planning.");
    t.succeeded();
    t.check(t.reply, includes("tax verification is required"));
    await t.send("Apply the current creation proposal.");
    t.succeeded();
    t.check(t.reply, includes("private preview"));
    t.check(t.reply, staysProductFacing);
    await t.send("Validate the applied creation.");
    t.succeeded();
    t.check(t.reply, includes("quality checks"));
    await t.send("Inspect the validated change set.");
    t.succeeded();
    await t.send("Accept the displayed change set.");
    t.succeeded();
    t.check(t.reply, includes("ready for review"));
    await t.send("Report artifact workflow status.");
    t.succeeded();
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
        browserPreview: true,
        operation: "iterate-existing-app",
        productOutcome: "tax-verification status is visible to operations",
        appId: "vendor",
        publicationAttempted: false,
      })}\n`,
    );
  },
});
