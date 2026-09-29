import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Read-only target identity and planning complete automatically without a user-input prompt.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    turn = await session.send(`Prepare supported repository at ${repository}`);
    turn = await session.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();
    turn = await session.send("Prepare offline target dependencies.");
    t.succeeded();
    turn = await session.send("Run target identity and planning.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(turn.message, includes("private preview"));
    t.check(
      turn.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/canonical proposal|digest-bound|target identity|target mutation/iu.test(reply),
        "automatic planning stays product-facing",
      ),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, includes('"phase":"planned"'));
  },
});
