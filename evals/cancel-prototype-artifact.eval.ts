import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Session-scoped prototype artifacts record and revise automatically without a user-input prompt.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();

    turn = await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    turn = await session.send(`Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    turn = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.notEvent("input.requested");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(turn.message, includes("invalidated the accepted AppSpec and proposal"));

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(turn.message, includes('"phase":"prepared"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
