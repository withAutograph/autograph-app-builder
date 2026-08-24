import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description: "Canceling acquisition never reaches materialization.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare fresh template at ${repository}`);
    t.requireInputRequest({ toolName: "approve_source_acquisition" });
    await t.respondAll("cancel");
    t.succeeded();
    t.calledTool("source_status", { count: 1 });
    t.calledTool("prepare_workspace", { count: 0 });
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(t.reply, includes("no workspace was materialized"));
  },
});
