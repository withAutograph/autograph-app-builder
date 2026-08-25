import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A fresh publication proposal rejects dirty approved-path overlap before approval or mutation.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await prepareReviewedWorkflow(t, repository, "publication-overlap");
    await writeFile(
      join(repository, "apps/shell/microfrontends.json"),
      "concurrent overlap\n",
    );

    await t.send("Publish reviewed change set locally with dirty overlap.");
    t.succeeded();
    t.check(
      t.reply,
      includes("rejected before approval or destination mutation"),
    );
    t.notCalledTool("publish_reviewed_change_set");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
