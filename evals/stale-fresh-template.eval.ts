import { defineEval } from "eve/evals";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "An unchanged eligible fresh template binds to one exact internal preparation without prompting.",
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
