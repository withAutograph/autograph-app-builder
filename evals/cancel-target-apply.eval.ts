import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Canceling target apply preserves the exact planned receipt and creates no apply overlay.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    await t.send("Prepare offline target dependencies.");
    await t.send("Run target identity and planning.");
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"planned"'));
    const before = t.reply;

    await t.send("Apply the current creation proposal.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("cancel");
    t.succeeded();
    t.check(t.reply, includes("planned phase was preserved"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, equals(before));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
