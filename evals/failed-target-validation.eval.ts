import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A failed target validation records recovery-required state and never reruns automatically.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();
    await session.send(`Prepare supported repository at ${repository}`);
    await session.send(
      `Accept build-ready AppSpec for validation-failure:\n${BUILD_READY_APP_SPEC}`,
    );
    await session.send("Prepare offline target dependencies.");
    await session.send("Run target identity and planning.");
    await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    await session.respondAll("approve");
    t.succeeded();

    const validation = await session.send("Validate the applied creation.");

    t.succeeded();
    validation.notEvent("input.requested");
    t.check(validation.message, includes("did not pass its quality checks"));
    t.check(validation.message, includes("needs another revision"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn1 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn1.message, includes('"phase":"validation_failed"'));
    t.check(turn1.message, includes('"recoveryRequired":true'));

    const retry = await session.send("Retry target validation after a lost response.");

    t.succeeded();
    retry.notEvent("input.requested");
    t.check(retry.message, includes("did not pass its quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
