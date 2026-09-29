import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A workflow-pending crash before journal creation is readable and never redispatched.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(
      t,
      repository,
      "publication-pre-journal-interruption",
    );
    await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await session.respondAll("approve");
    t.succeeded();

    const turn1 = await session.send("Retry local publication after a lost response.");
    t.succeeded();
    t.check(turn1.message, includes("not redispatched automatically"));
    const turn2 = await session.send("Report artifact workflow status.");
    t.check(turn2.message, includes('"phase":"publication_pending"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
