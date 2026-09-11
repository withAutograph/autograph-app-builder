import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Session-scoped prototype artifacts record and revise automatically without a user-input prompt.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    await t.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.notEvent("input.requested");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(t.reply, includes("invalidated the accepted AppSpec and proposal"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(t.reply, includes('"phase":"prepared"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
