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
    "Eve refuses fresh bootstrap for an existing-repository source without fallback mutation.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(t, repository, "wrong-source-eval");
    const fixture = await createFreshBootstrapEvalCapability();
    try {
      await withFreshBootstrapTestCapability(fixture.capability, () =>
        t.send(
          `Inspect fresh repository bootstrap at ${join(fixture.allowedRoot, "wrong-source")}.`,
        ),
      );
      t.succeeded();
      t.check(t.reply, includes("rejected without target mutation"));
      t.notCalledTool("publish_fresh_repository");
      t.notCalledTool("recover_fresh_repository");
      t.notCalledTool("bash");
      t.notCalledTool("write_file");
    } finally {
      await fixture.cleanup();
    }
  },
});
