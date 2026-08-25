import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A workflow-pending crash before journal creation is readable and never redispatched.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "publication-pre-journal-interruption",
    );
    await t.send("Publish reviewed change set locally.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Retry local publication after a lost response.");
    t.succeeded();
    t.check(t.reply, includes("not redispatched automatically"));
    await t.send("Report artifact workflow status.");
    t.check(t.reply, includes('"phase":"publication_pending"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
