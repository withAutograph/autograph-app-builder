import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareReviewedWorkflow } from "./support/reviewed-workflow";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A fresh publication proposal rejects dirty approved-path overlap before approval or mutation.",
  async test(t) {
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();
    const session = await prepareReviewedWorkflow(t, repository, "publication-overlap");
    const appPath = path.join(repository, "apps/publication-overlap/app");
    await mkdir(appPath, { recursive: true });
    await writeFile(path.join(appPath, "page.tsx"), "concurrent overlap\n");

    turn = await session.send("Publish reviewed change set locally with dirty overlap.");
    t.succeeded();
    t.check(turn.message, includes("rejected before approval or destination mutation"));
    t.notCalledTool("publish_reviewed_change_set");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
