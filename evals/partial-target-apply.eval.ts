import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A partial target apply records recovery-required state and never retries automatically.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    await t.send(
      `Accept build-ready AppSpec for apply-failure:\n${BUILD_READY_APP_SPEC}`,
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
    t.succeeded();

    await t.send("Apply the current creation proposal.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("recovery-required partial-failure receipt"));
    t.check(t.reply, includes("will not retry automatically"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"apply_failed"'));
    t.check(t.reply, includes('"recoveryRequired":true'));

    await t.send("Retry target apply after a lost response.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("recovery-required partial-failure receipt"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
