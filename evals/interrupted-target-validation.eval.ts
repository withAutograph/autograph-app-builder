import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "An interrupted command records a durable timeout failure; explicit retry reattempts the command and retains failure while the timeout persists.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();
    await session.send(`Prepare supported repository at ${repository}`);
    await session.send(
      `Accept build-ready AppSpec for validation-interruption:\n${BUILD_READY_APP_SPEC}`,
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
    validation.calledTool("validate_app_creation", { count: 1 });
    t.check(validation, includes("did not pass its quality checks"));
    t.check(validation, includes("needs another revision"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn1 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn1.message, includes('"phase":"validation_failed"'));
    t.check(turn1.message, includes('"recoveryRequired":true'));
    t.check(turn1.message, includes('"reason":"command-timeout"'));

    const retry = await session.send("Retry target validation after a lost response.");

    t.succeeded();
    retry.notEvent("input.requested");
    retry.calledTool("validate_app_creation", { count: 1 });
    t.check(retry, includes("did not pass its quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    const turn2 = await session.send("Report artifact workflow status.");
    t.check(turn2.message, includes('"phase":"validation_failed"'));
    t.check(turn2.message, includes('"reason":"command-timeout"'));
    t.check(turn2.message, includes('"recoveryRequired":true'));
    t.calledTool("validate_app_creation", { count: 2 });
  },
});
