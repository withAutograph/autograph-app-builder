import path from "node:path";

import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

import {
  createFreshBootstrapEvalCapability,
  withFreshBootstrapEvalCapability as withFreshBootstrapTestCapability,
} from "./support/fresh-bootstrap-capability";
import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Eve uses only the approval-bound fresh-bootstrap tools for an absent local destination.",
  tags: ["fresh-bootstrap-publication"],
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "fresh-eval", "fresh-template");
    const fixture = await createFreshBootstrapEvalCapability();
    try {
      const destination = path.join(fixture.allowedRoot, "absent");
      const publication = await withFreshBootstrapTestCapability(fixture.capability, () =>
        session.send(`Publish fresh repository bootstrap at ${destination}.`),
      );
      turn = publication;
      session.requireInputRequest({ toolName: "publish_fresh_repository" });
      publication.event("input.requested", { count: 1 });
      turn = await withFreshBootstrapTestCapability(fixture.capability, () =>
        session.respondAll("approve"),
      );
      t.succeeded();
      t.check(turn.message, includes("one parentless SHA-1 local repository"));
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
