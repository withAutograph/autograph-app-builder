import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A partial target apply records recovery-required state and never retries automatically.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();
    await session.send(`Prepare supported repository at ${repository}`);
    await session.send(`Accept build-ready AppSpec for apply-failure:\n${BUILD_READY_APP_SPEC}`);
    await session.send("Prepare offline target dependencies.");
    await session.send("Run target identity and planning.");
    t.succeeded();

    await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn1.message, includes("couldn't finish preparing the app safely"));
    t.check(turn1.message, includes("current plan remains available"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn2 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn2.message, includes('"phase":"apply_failed"'));
    t.check(turn2.message, includes('"recoveryRequired":true'));

    const retryApply = await session.send("Retry target apply after a lost response.");

    t.succeeded();
    retryApply.notEvent("input.requested");
    retryApply.calledTool("apply_app_creation", { count: 1, status: "failed" });
    t.check(retryApply, includes("couldn't finish preparing the app safely"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn3 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn3.message, includes('"phase":"apply_failed"'));
    t.check(turn3.message, includes('"recoveryRequired":true'));
  },
});
