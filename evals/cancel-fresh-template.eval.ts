import { defineEval } from "eve/evals";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Fresh-template source binding and preparation are automatic internal work.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare fresh template at ${repository}`);
    t.succeeded();
    t.notEvent("input.requested");
    t.calledTool("approve_source_acquisition", { count: 1 });
    t.calledTool("prepare_workspace", { count: 1 });
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
