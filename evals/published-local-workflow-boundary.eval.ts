import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A completed local publication is terminal and rejects prototype and AppSpec mutation.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "published-boundary");

    await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await session.respondAll("approve");
    t.succeeded();

    const turn1 = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.check(turn1.message, includes("durable state was not changed"));

    const turn2 = await session.send("Attempt AppSpec mutation after publication.");
    t.succeeded();
    t.check(turn2.message, includes("denied by the terminal publication workflow"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
