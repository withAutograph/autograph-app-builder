import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { z } from "zod";

import { renewalReviewDesignPrompt } from "../lib/testing/prompt-driven-design";
import { isProductFacing } from "./support/public-conversation";
import { observeRecordedRenewalReview } from "./support/ui-preview-browser";

const previewFileSchema = z.object({ content: z.string() });
const previewManifestSchema = z.object({
  assumptions: z.array(z.unknown()).optional(),
  decisions: z.array(z.unknown()).optional(),
  openQuestions: z.array(z.unknown()).optional(),
  productionComponents: z.array(z.unknown()).optional(),
  productionCompositions: z.array(z.object({ name: z.unknown() })).optional(),
});
const previewInputSchema = z.unknown();

const hasEnoughComponents = (manifest: z.infer<typeof previewManifestSchema>): boolean =>
  (manifest.productionComponents?.length ?? 0) >= 4;

const hasTableComposition = (manifest: z.infer<typeof previewManifestSchema>): boolean =>
  manifest.productionCompositions?.some(({ name }) => name === "DataTableComposition") ?? false;

const hasOneAssumption = (manifest: z.infer<typeof previewManifestSchema>): boolean =>
  manifest.assumptions?.length === 1;

const hasNoDecisions = (manifest: z.infer<typeof previewManifestSchema>): boolean =>
  manifest.decisions?.length === 0;

const hasOneOpenQuestion = (manifest: z.infer<typeof previewManifestSchema>): boolean =>
  manifest.openQuestions?.length === 1;

const hasExpectedPreviewContent = (content: string): boolean => {
  const includesTableComposition = content.includes("DataTableComposition");
  const avoidsFetchCalls = !content.includes("fetch(");
  return includesTableComposition && avoidsFetchCalls;
};

export default defineEval({
  description:
    "An ambiguous product brief compiles against the supported source and passes real browser interaction before UI review; compilation runs in Vercel Sandbox.",
  tags: ["product-quality", "design-guidance", "sandbox-integration"],
  async test(t) {
    const session = await t.session();
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0) {
      throw new Error("The supported source root is missing.");
    }
    const turn = await session.send(`Supported repository at ${repository}
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
        files: (value) => {
          const parsedInput = previewInputSchema.safeParse(value);
          if (!parsedInput.success) {
            return false;
          }
          const files = z.array(previewFileSchema).safeParse(parsedInput.data);
          if (!files.success) {
            return false;
          }
          return files.data.some(({ content }) => hasExpectedPreviewContent(content));
        },
        manifest: (value) => {
          const parsedInput = previewInputSchema.safeParse(value);
          if (!parsedInput.success) {
            return false;
          }
          const parsed = previewManifestSchema.safeParse(parsedInput.data);
          if (!parsed.success) {
            return false;
          }
          const { data: manifest } = parsed;
          return [
            hasEnoughComponents(manifest) && hasTableComposition(manifest),
            hasOneAssumption(manifest),
            hasNoDecisions(manifest),
            hasOneOpenQuestion(manifest),
          ].every(Boolean);
        },
        routes: ["/"],
      },
    });
    t.notCalledTool("record_prototype_artifact");
    t.notCalledTool("record_prototype_bundle");
    t.notCalledTool("accept_ui_preview");
    t.notCalledTool("apply_app_creation");
    t.notCalledTool("validate_app_creation");
    t.notCalledTool("prepare_target_dependencies");
    const browserObservation = await observeRecordedRenewalReview(session.events);
    process.stdout.write(
      `${JSON.stringify({
        browserInteraction: browserObservation,
        renderer: "current-supported-source",
        version: 1,
      })}\n`,
    );
    t.check(turn.message, includes("Renewal Review"));
    t.check(turn.message, includes("existing table and review components"));
    t.check(turn.message, includes("remains open"));
    t.check(
      turn.message,
      satisfies(
        (reply) =>
          isProductFacing(String(reply)) &&
          !/implementation plan|Context|Draft spec|manifest|receipt/iu.test(String(reply)),
        "the review remains product-facing and exposes no internal workbench material",
      ),
    );
  },
  // Include measured cold shared toolchain preparation before workflow assertions.
  timeoutMs: 600_000,
});
