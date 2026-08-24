import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A fresh local template requires acquisition approval before workspace preparation approval.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare fresh template at ${repository}`);
    t.calledTool("inspect_source", { count: 1 });
    t.requireInputRequest({ toolName: "approve_source_acquisition" });
    await t.respondAll("approve");
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("prepare_workspace", { count: 1 });
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(t.reply, includes("confirms the prepared phase"));
  },
});
