import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Canceling offline dependency preparation preserves exact accepted AppSpec state and runs no target command.",
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
    t.succeeded();

    await t.send("Prepare offline target dependencies.");
    t.requireInputRequest({ toolName: "prepare_target_dependencies" });
    await t.respondAll("cancel");
    t.succeeded();
    t.check(t.reply, includes("accepted AppSpec state was preserved"));
    t.notCalledTool("plan_app_creation");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"app_spec_accepted"'));
  },
});
