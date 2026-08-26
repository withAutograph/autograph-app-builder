import { join } from "node:path";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import {
  createFreshBootstrapEvalCapability,
  withFreshBootstrapEvalCapability as withFreshBootstrapTestCapability,
} from "./support/fresh-bootstrap-capability";
import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  tags: ["fresh-bootstrap-publication"],
  description:
    "Eve requires separate approval for exact fresh-bootstrap recovery and reuses terminal state after a lost response.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "fresh-recovery-eval",
      "fresh-template",
    );
    const fixture = await createFreshBootstrapEvalCapability();
    try {
      const destination = join(fixture.allowedRoot, "recovery");
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send(`Publish fresh repository bootstrap at ${destination}.`),
      );
      t.requireInputRequest({ toolName: "publish_fresh_repository" });
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.respondAll("approve"),
      );
      t.succeeded();

      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send("Recover fresh repository bootstrap after partial failure."),
      );
      t.requireInputRequest({ toolName: "recover_fresh_repository" });
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.respondAll("approve"),
      );
      t.succeeded();
      t.check(t.reply, includes("separately approved exact"));

      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send("Retry fresh repository recovery after a lost response."),
      );
      t.succeeded();
      t.check(t.reply, includes("without redispatching recovery"));
      t.calledTool("recover_fresh_repository", { count: 1 });
      t.notCalledTool("bash");
      t.notCalledTool("write_file");
      t.notCalledTool("publish_reviewed_change_set");
      t.notCalledTool("publish_reviewed_change_set_to_branch_worktree");
    } finally {
      await fixture.cleanup();
    }
  },
});
