import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { renewalReviewDesignPrompt } from "../lib/testing/prompt-driven-design";
import { isProductFacing } from "./support/public-conversation";
import { observeRecordedRenewalReview } from "./support/ui-preview-browser";

export default defineEval({
  description:
    "An ambiguous product brief compiles against the supported source and passes real browser interaction in Vercel Sandbox before UI review.",
  tags: ["product-quality", "design-guidance", "sandbox-integration"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The supported source root is missing.");
    await t.send(`Supported repository at ${repository}
${renewalReviewDesignPrompt}`);

    t.succeeded();
    t.toolOrder(["inspect_source", "prepare_workspace", "record_ui_preview"]);
    // A successful retry must not hide an invalid first preview. The default
    // calledTool matcher counts completed calls only.
    t.calledTool("record_ui_preview", { count: 0, status: "failed" });
    t.calledTool("record_ui_preview", { count: 0, status: "rejected" });
    t.calledTool("record_ui_preview", { count: 1 });
    t.calledTool("record_ui_preview", {
      count: 1,
      input: {
        catalogGaps: [],
        files: (value) =>
          Array.isArray(value) &&
          value.some(
            (file) =>
              typeof file === "object" &&
              file !== null &&
              "content" in file &&
              typeof file.content === "string" &&
              file.content.includes("DataTableComposition") &&
              !file.content.includes("fetch("),
          ),
        manifest: (value) => {
          if (typeof value !== "object" || value === null) return false;
          const manifest = value as {
            productionComponents?: unknown[];
            productionCompositions?: { name?: unknown }[];
            assumptions?: unknown[];
            decisions?: unknown[];
            openQuestions?: unknown[];
          };
          return (
            (manifest.productionComponents?.length ?? 0) >= 4 &&
            manifest.productionCompositions?.some(({ name }) => name === "DataTableComposition") ===
              true &&
            (manifest.assumptions?.length ?? 0) === 1 &&
            (manifest.decisions?.length ?? 0) === 0 &&
            (manifest.openQuestions?.length ?? 0) === 1
          );
        },
        routes: ["/"],
      },
    });
    t.notCalledTool("record_prototype_artifact");
    t.notCalledTool("record_prototype_bundle");
    t.notCalledTool("accept_ui_preview");
    t.notCalledTool("plan_app_creation");
    t.notCalledTool("apply_app_creation");
    t.notCalledTool("validate_app_creation");
    t.notCalledTool("prepare_target_dependencies");
    const browserObservation = await observeRecordedRenewalReview(t.events);
    process.stdout.write(
      `${JSON.stringify({
        browserInteraction: browserObservation,
        renderer: "current-supported-source",
        version: 1,
      })}\n`,
    );
    t.check(t.reply, includes("Renewal Review"));
    t.check(t.reply, includes("existing table and review components"));
    t.check(t.reply, includes("remains open"));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          isProductFacing(reply) &&
          !/implementation plan|Context|Draft spec|manifest|receipt/iu.test(String(reply)),
        "the review remains product-facing and exposes no internal workbench material",
      ),
    );
  },
});
