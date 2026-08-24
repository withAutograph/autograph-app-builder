import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Canceling target identity/planning preserves accepted AppSpec state and performs no target mutation.",
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
    await t.send("Run target identity and planning.");
    t.requireInputRequest({ toolName: "plan_app_creation" });
    await t.respondAll("cancel");
    t.succeeded();
    t.check(t.reply, includes("no target mutation occurred"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"app_spec_accepted"'));
  },
});
