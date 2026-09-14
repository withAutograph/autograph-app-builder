import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Offline dependency preparation is automatic internal planning and emits no user-input prompt.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    await t.send(`Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
    const recordedStatus = t.reply;
    t.check(
      recordedStatus,
      satisfies((reply) => {
        if (typeof reply !== "string") {
          return false;
        }
        try {
          const state = JSON.parse(reply.slice(reply.indexOf("{")));
          return (
            state.phase === "planned" && /^[a-f0-9]{64}$/u.test(state.dependencies?.digest ?? "")
          );
        } catch {
          return false;
        }
      }, "planning recorded a durable dependency receipt"),
    );

    const preparation = await t.send("Prepare offline target dependencies.");
    t.succeeded();
    preparation.notEvent("input.requested");
    t.notCalledTool("prepare_target_dependencies");
    preparation.notCalledTool("plan_app_creation");
    preparation.notCalledTool("apply_app_creation");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes('"phase":"planned"'));
    t.check(t.reply, equals(recordedStatus));
  },
});
