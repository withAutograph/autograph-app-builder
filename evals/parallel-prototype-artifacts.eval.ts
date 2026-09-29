import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Three session-scoped prototype artifacts record automatically without losing state or requesting input.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();
    await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    const turn1 = await session.send("Record three prototype artifacts in parallel.");
    t.succeeded();
    t.notEvent("input.requested");
    t.calledTool("record_prototype_artifact", { count: 3 });
    t.check(turn1.message, includes("All three prototype artifacts were recorded"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn2 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn2.message, includes("app-spec.md"));
    t.check(turn2.message, includes("decisions.md"));
    t.check(turn2.message, includes("index.html"));
  },
});
