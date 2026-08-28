import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Three session-scoped prototype artifacts record automatically without losing state or requesting input.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send("Record three prototype artifacts in parallel.");
    t.succeeded();
    t.notEvent("input.requested");
    t.calledTool("record_prototype_artifact", { count: 3 });
    t.check(t.reply, includes("All three prototype artifacts were recorded"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes("app-spec.md"));
    t.check(t.reply, includes("decisions.md"));
    t.check(t.reply, includes("index.html"));
  },
});
