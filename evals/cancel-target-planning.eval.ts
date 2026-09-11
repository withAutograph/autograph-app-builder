import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Read-only target identity and planning complete automatically without a user-input prompt.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();
    await t.send("Prepare offline target dependencies.");
    t.succeeded();
    await t.send("Run target identity and planning.");
    t.succeeded();
    t.notEvent("input.requested");
    t.notCalledTool("plan_app_creation");
    t.check(t.reply, includes("private preview"));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/canonical proposal|digest-bound|target identity|target mutation/iu.test(
            reply,
          ),
        "automatic planning stays product-facing",
      ),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"planned"'));
  },
});
