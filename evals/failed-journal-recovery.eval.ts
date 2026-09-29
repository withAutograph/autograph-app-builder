import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable failure written before workflow CAS is terminalized without mutation redispatch.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "publication-failure-recovery");
    await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await session.respondAll("approve");
    t.succeeded();

    await session.send("Retry local publication after a lost response.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await session.respondAll("approve");
    t.succeeded();
    const turn1 = await session.send("Report artifact workflow status.");
    t.check(turn1.message, includes('"phase":"publication_failed"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
