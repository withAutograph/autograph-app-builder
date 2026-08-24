import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Canceling preparation leaves the durable App Builder workspace phase empty.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.calledTool("inspect_repository", { count: 1 });
    t.requireInputRequest({ toolName: "prepare_workspace" });

    await t.respondAll("cancel");
    t.succeeded();
    t.calledTool("workspace_status", { count: 1 });
    t.check(t.reply, includes("workspace phase remains empty"));
  },
});
