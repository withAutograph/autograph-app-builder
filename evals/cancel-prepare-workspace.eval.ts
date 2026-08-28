import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Eligible source preparation completes automatically without a workspace-approval prompt.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.calledTool("inspect_source", { count: 1 });
    t.succeeded();
    t.notEvent("input.requested");
    t.calledTool("prepare_workspace", { count: 1 });
    t.calledTool("workspace_status", { count: 1 });
    t.check(t.reply, includes("confirms the prepared phase"));
  },
});
