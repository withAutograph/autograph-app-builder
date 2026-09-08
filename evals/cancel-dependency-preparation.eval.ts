import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Offline dependency preparation is automatic internal planning and emits no user-input prompt.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();

    await t.send("Prepare offline target dependencies.");
    t.succeeded();
    t.notEvent("input.requested");
    t.notCalledTool("prepare_target_dependencies");
    t.check(t.reply, includes("already available"));
    t.notCalledTool("plan_app_creation");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"planned"'));
  },
});
