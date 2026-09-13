import path from "node:path";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import {
  createFreshBootstrapEvalCapability,
  withFreshBootstrapEvalCapability as withFreshBootstrapTestCapability,
} from "./support/fresh-bootstrap-capability";
import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Eve requires separate approval for exact fresh-bootstrap recovery and reuses terminal state after a lost response.",
  tags: ["fresh-bootstrap-publication"],
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(t, repository, "fresh-recovery-eval", "fresh-template");
    const fixture = await createFreshBootstrapEvalCapability();
    try {
      const destination = path.join(fixture.allowedRoot, "recovery");
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send(`Publish fresh repository bootstrap at ${destination}.`),
      );
      t.requireInputRequest({ toolName: "publish-fresh-repository" });
      await withFreshBootstrapTestCapability(fixture.capability, () => t.respondAll("approve"));
      t.succeeded();

      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send("Recover fresh repository bootstrap after partial failure."),
      );
      t.requireInputRequest({ toolName: "recover-fresh-repository" });
      await withFreshBootstrapTestCapability(fixture.capability, () => t.respondAll("approve"));
      t.succeeded();
      t.check(t.reply, includes("separately approved exact"));

      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send("Retry fresh repository recovery after a lost response."),
      );
      t.succeeded();
      t.check(t.reply, includes("without redispatching recovery"));
      t.calledTool("recover-fresh-repository", { count: 1 });
      t.notCalledTool("bash");
      t.notCalledTool("write-file");
      t.notCalledTool("publish-reviewed-change-set");
      t.notCalledTool("publish-reviewed-change-set_to_branch_worktree");
    } finally {
      await fixture.cleanup();
    }
  },
});
