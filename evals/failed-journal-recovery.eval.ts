import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable failure written before workflow CAS is terminalized without mutation redispatch.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "publication-failure-recovery",
    );
    await t.send("Publish reviewed change set locally.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Retry local publication after a lost response.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    await t.send("Report artifact workflow status.");
    t.check(t.reply, includes('"phase":"publication_failed"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
