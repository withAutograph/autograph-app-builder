import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A failed target validation records recovery-required state and never reruns automatically.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    await t.send(
      `Accept build-ready AppSpec for validation-failure:\n${BUILD_READY_APP_SPEC}`,
    );
    await t.send("Prepare offline target dependencies.");
    await t.send("Run target identity and planning.");
    await t.send("Apply the current creation proposal.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Validate the applied creation.");
    t.requireInputRequest({ toolName: "validate_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("recovery-required failure receipt"));
    t.check(t.reply, includes("will not retry automatically"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"validation_failed"'));
    t.check(t.reply, includes('"recoveryRequired":true'));

    await t.send("Retry target validation after a lost response.");
    t.requireInputRequest({ toolName: "validate_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("recovery-required failure receipt"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
