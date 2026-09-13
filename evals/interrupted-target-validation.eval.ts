import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "An interrupted target validation leaves a durable pending receipt and never redispatches automatically.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    await t.send(
      `Accept build-ready AppSpec for validation-interruption:\n${BUILD_READY_APP_SPEC}`,
    );
    await t.send("Prepare offline target dependencies.");
    await t.send("Run target identity and planning.");
    await t.send("Apply the current creation proposal.");
    t.succeeded();
    t.notEvent("input.requested");

    await t.send("Validate the applied creation.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("checks did not finish"));
    t.check(t.reply, includes("preview still needs review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"validation_pending"'));
    t.check(t.reply, includes('"recoveryRequired":true'));

    await t.send("Retry target validation after a lost response.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("checks did not finish"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
