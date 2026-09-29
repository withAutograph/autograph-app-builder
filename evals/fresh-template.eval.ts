import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A fresh local template binds and prepares automatically without internal approval prompts.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    turn = await session.send(`Prepare fresh template at ${repository}`);
    t.calledTool("inspect_source", { count: 1 });
    t.succeeded();
    t.notEvent("input.requested");
    t.calledTool("approve_source_acquisition", { count: 1 });
    t.calledTool("prepare_workspace", { count: 1 });
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(turn.message, includes("confirms the prepared phase"));
  },
});
