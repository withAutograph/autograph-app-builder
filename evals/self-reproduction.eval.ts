import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  tags: ["self-reproduction", "sandbox", "live-model"],
  timeoutMs: 900_000,
  description:
    "The live App Builder model creates an independent App Builder replica from the checked-in product brief.",
  async test(t) {
    const brief = await readFile(
      resolve(process.cwd(), "evals/self-reproduction/brief.md"),
      "utf8",
    );
    const answers = await readFile(
      resolve(process.cwd(), "evals/self-reproduction/answers.json"),
      "utf8",
    );
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The signed self-reproduction source root is missing.");

    await t.send(
      `Inspect the existing repository at ${repository}. Review this exact source before preparing a workspace.`,
    );
    t.succeeded();
    t.calledTool("inspect_source", { count: 1 });

    await t.send("Prepare the reviewed repository workspace.");
    t.succeeded();
    t.calledTool("prepare_workspace", { count: 1 });

    await t.send(
      `${brief}\n\nFixed benchmark answers (use these without asking product questions):\n${answers}\n\nDesign the replica and accept a build-ready AppSpec. Stop before target planning.`,
    );
    t.succeeded();
    t.check(
      t.reply,
      satisfies(
        (reply) => typeof reply === "string" && reply.trim().length > 0,
        "the live model returned a product-facing result",
      ),
    );

    await t.send("Prepare offline target dependencies.");
    t.succeeded();

    await t.send("Run target identity and planning.");
    t.succeeded();

    await t.send("Apply the current creation proposal.");
    t.succeeded();

    await t.send("Validate the applied creation.");
    t.succeeded();

    await t.send("Inspect the validated change set.");
    t.succeeded();

    await t.send("Accept the displayed change set.");
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
  },
});
