import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A failed target validation records recovery-required state and never reruns automatically.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    turn = await session.send(`Prepare supported repository at ${repository}`);
    turn = await session.send(
      `Accept build-ready AppSpec for validation-failure:\n${BUILD_READY_APP_SPEC}`,
    );
    turn = await session.send("Prepare offline target dependencies.");
    turn = await session.send("Run target identity and planning.");
    turn = await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    turn = await session.respondAll("approve");
    t.succeeded();

    const validation = await session.send("Validate the applied creation.");
    turn = validation;
    t.succeeded();
    validation.notEvent("input.requested");
    t.check(turn.message, includes("did not pass its quality checks"));
    t.check(turn.message, includes("needs another revision"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, includes('"phase":"validation_failed"'));
    t.check(turn.message, includes('"recoveryRequired":true'));

    const retry = await session.send("Retry target validation after a lost response.");
    turn = retry;
    t.succeeded();
    retry.notEvent("input.requested");
    t.check(turn.message, includes("did not pass its quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
