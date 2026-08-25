import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A completed local publication is terminal and rejects prototype and AppSpec mutation.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(t, repository, "published-boundary");

    await t.send("Publish reviewed change set locally.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Record a replacement prototype artifact.");
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("durable state was not changed"));

    await t.send("Attempt AppSpec mutation after publication.");
    t.requireInputRequest({ toolName: "accept_app_spec" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("denied by the terminal publication workflow"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
