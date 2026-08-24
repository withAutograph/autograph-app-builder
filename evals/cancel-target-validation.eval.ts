import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Canceling target validation preserves the exact applied receipt and creates no validation overlay.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.requireInputRequest({ toolName: "accept_app_spec" });
    await t.respondAll("approve");
    await t.send("Prepare offline target dependencies.");
    t.requireInputRequest({ toolName: "prepare_target_dependencies" });
    await t.respondAll("approve");
    await t.send("Run target identity and planning.");
    t.requireInputRequest({ toolName: "plan_app_creation" });
    await t.respondAll("approve");
    await t.send("Apply the current creation proposal.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"applied"'));
    const before = t.reply;

    await t.send("Validate the applied creation.");
    t.requireInputRequest({ toolName: "validate_app_creation" });
    await t.respondAll("cancel");
    t.succeeded();
    t.check(t.reply, includes("exact applied phase was preserved"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, equals(before));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
