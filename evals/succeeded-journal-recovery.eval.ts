import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A durable success written before workflow CAS is verified and terminalized without mutation redispatch.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "publication-success-recovery");
    await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await session.respondAll("approve");
    t.succeeded();

    await session.send("Retry local publication after a lost response.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn1.message, includes("reused the exact durable"));
    const turn2 = await session.send("Report artifact workflow status.");
    t.check(turn2.message, includes('"phase":"published_local"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
