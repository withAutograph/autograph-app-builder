import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "An ambiguous product brief reaches a component-backed, assumption-aware UI review without HTML, local surrogates, planning, or backend work.",
  tags: ["product-quality", "design-guidance"],
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Supported repository at ${repository}
Create a component-backed renewal review UI for customer-success managers deciding which upcoming renewals need intervention. The workflow is not settled yet.`);

    t.succeeded();
    t.toolOrder(["inspect_source", "prepare_workspace", "record_ui_preview"]);
    t.calledTool("record_ui_preview", {
      input: {
        routes: ["/"],
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
            (manifest.productionComponents?.length ?? 0) >= 3 &&
            manifest.productionCompositions?.some(
              ({ name }) => name === "DataTableComposition",
            ) === true &&
            (manifest.assumptions?.length ?? 0) === 1 &&
            (manifest.decisions?.length ?? 0) === 0 &&
            (manifest.openQuestions?.length ?? 0) === 1
          );
        },
        catalogGaps: [],
      },
      count: 1,
    });
    t.notCalledTool("record_prototype_artifact");
    t.notCalledTool("record_prototype_bundle");
    t.notCalledTool("accept_ui_preview");
    t.notCalledTool("plan_app_creation");
    t.notCalledTool("apply_app_creation");
    t.notCalledTool("validate_app_creation");
    t.notCalledTool("prepare_target_dependencies");
    t.check(t.reply, includes("Renewal Review"));
    t.check(t.reply, includes("existing table and review components"));
    t.check(t.reply, includes("remains open"));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          isProductFacing(reply) &&
          !/implementation plan|Context|Draft spec|manifest|receipt/iu.test(
            String(reply),
          ),
        "the review remains product-facing and exposes no internal workbench material",
      ),
    );
  },
});
