import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Three session-scoped prototype artifacts record automatically without losing state or requesting input.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    turn = await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    turn = await session.send("Record three prototype artifacts in parallel.");
    t.succeeded();
    t.notEvent("input.requested");
    t.calledTool("record_prototype_artifact", { count: 3 });
    t.check(turn.message, includes("All three prototype artifacts were recorded"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, includes("app-spec.md"));
    t.check(turn.message, includes("decisions.md"));
    t.check(turn.message, includes("index.html"));
  },
});
