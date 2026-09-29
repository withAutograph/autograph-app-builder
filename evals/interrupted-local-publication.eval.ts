import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable pending local publication is never redispatched and blocks every upstream mutation.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "publication-interruption");

    await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await session.respondAll("approve");
    t.succeeded();

    const turn1 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn1.message, includes('"phase":"publication_pending"'));

    const turn2 = await session.send("Retry local publication after a lost response.");
    t.succeeded();
    t.check(turn2.message, includes("not redispatched automatically"));

    const turn3 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn3.message, includes('"phase":"publication_pending"'));

    const turn4 = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.check(turn4.message, includes("durable state was not changed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
