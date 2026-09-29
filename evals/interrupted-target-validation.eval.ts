import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "An interrupted command records a durable timeout failure; explicit retry reattempts the command and retains failure while the timeout persists.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    turn = await session.send(`Prepare supported repository at ${repository}`);
    turn = await session.send(
      `Accept build-ready AppSpec for validation-interruption:\n${BUILD_READY_APP_SPEC}`,
    );
    turn = await session.send("Prepare offline target dependencies.");
    turn = await session.send("Run target identity and planning.");
    turn = await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    turn = await session.respondAll("approve");
    t.succeeded();

    const validation = turn = await session.send("Validate the applied creation.");
    t.succeeded();
    validation.notEvent("input.requested");
    validation.calledTool("validate_app_creation", { count: 1 });
    t.check(turn.message, includes("did not pass its quality checks"));
    t.check(turn.message, includes("needs another revision"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, includes('"phase":"validation_failed"'));
    t.check(turn.message, includes('"recoveryRequired":true'));
    t.check(turn.message, includes('"reason":"command-timeout"'));

    const retry = turn = await session.send("Retry target validation after a lost response.");
    t.succeeded();
    retry.notEvent("input.requested");
    retry.calledTool("validate_app_creation", { count: 1 });
    t.check(turn.message, includes("did not pass its quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    turn = await session.send("Report artifact workflow status.");
    t.check(turn.message, includes('"phase":"validation_failed"'));
    t.check(turn.message, includes('"reason":"command-timeout"'));
    t.check(turn.message, includes('"recoveryRequired":true'));
    t.calledTool("validate_app_creation", { count: 2 });
  },
});
