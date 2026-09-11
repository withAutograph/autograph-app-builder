import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable success written before workflow CAS is verified and terminalized without mutation redispatch.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "publication-success-recovery",
    );
    await t.send("Publish reviewed change set locally.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Retry local publication after a lost response.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("reused the exact durable"));
    await t.send("Report artifact workflow status.");
    t.check(t.reply, includes('"phase":"published_local"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
