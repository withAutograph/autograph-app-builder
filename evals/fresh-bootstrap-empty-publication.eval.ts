import { mkdir } from "node:fs/promises";
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
  description: "Eve atomically exchanges only an exact approved empty local destination.",
  tags: ["fresh-bootstrap-publication"],
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    const [session, fixture] = await Promise.all([
      prepareReviewedWorkflow(t, repository, "fresh-empty-eval", "fresh-template"),
      createFreshBootstrapEvalCapability(),
    ]);
    try {
      const destination = path.join(fixture.allowedRoot, "exact-empty");
      await mkdir(destination, { mode: 0o700 });
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        session.send(`Publish fresh repository bootstrap at ${destination} exact-empty.`),
      );
      session.requireInputRequest({ toolName: "publish_fresh_repository" });
      const turn1 = await withFreshBootstrapTestCapability(fixture.capability, () =>
        session.respondAll("approve"),
      );
      t.succeeded();
      t.check(turn1.message, includes("one parentless SHA-1 local repository"));
      t.calledTool("fresh_bootstrap_status", { count: 1 });
      t.calledTool("publish_fresh_repository", { count: 1 });
      t.notCalledTool("bash");
      t.notCalledTool("write_file");
      t.notCalledTool("publish_reviewed_change_set");
      t.notCalledTool("publish_reviewed_change_set_to_branch_worktree");
    } finally {
      await fixture.cleanup();
    }
  },
});
