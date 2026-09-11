import { mkdir } from "node:fs/promises";
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
    "Eve atomically exchanges only an exact approved empty local destination.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(
      t,
      repository,
      "fresh-empty-eval",
      "fresh-template",
    );
    const fixture = await createFreshBootstrapEvalCapability();
    try {
      const destination = join(fixture.allowedRoot, "exact-empty");
      await mkdir(destination, { mode: 0o700 });
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send(
          `Publish fresh repository bootstrap at ${destination} exact-empty.`,
        ),
      );
      t.requireInputRequest({ toolName: "publish_fresh_repository" });
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.respondAll("approve"),
      );
      t.succeeded();
      t.check(t.reply, includes("one parentless SHA-1 local repository"));
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
