import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "The Eve agent binds approval to eligibility and prepares the reviewed tree inside its session sandbox.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.calledTool("inspect_source", { count: 1 });
    t.requireInputRequest({ toolName: "prepare_workspace" });

    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("prepare_workspace", { count: 1 });
    t.calledTool("workspace_status", { count: 1 });
    t.check(
      t.reply,
      includes("prepared inside the App Builder session workspace"),
    );
    t.check(t.reply, includes("confirms the prepared phase"));
  },
});
