import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { z } from "zod";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { isProductFacing } from "./support/public-conversation";

const staysProductFacing = satisfies(
  (reply) =>
    isProductFacing(reply) &&
    !/(?:builder-owned|overlay|fixed check|normalized change set|approval receipt|publication did not run|nothing (?:has been|was) published)/iu.test(
      String(reply),
    ),
  "assistant reply stays product-facing and omits internal review mechanics",
);

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const reviewedStateSchema = z.object({
  apply: z.object({ digest: digestSchema, status: z.literal("applied") }),
  dependencies: z.object({ digest: digestSchema }),
  identity: z.object({ digest: digestSchema }),
  phase: z.literal("reviewed"),
  proposal: z.object({ digest: digestSchema }),
  review: z.object({ changeSetDigest: digestSchema, digest: digestSchema }),
  validation: z.object({ digest: digestSchema, status: z.literal("passed") }),
});

export default defineEval({
  description:
    "The current Vercel Sandbox applies and validates one supported-source proposal, then records the reviewed change set without publication.",
  tags: ["sandbox-integration", "reviewed-change-set"],
  async test(t) {
    const session = await t.session();
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0) {
      throw new Error("The supported source root is missing.");
    }

    await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await session.send(
      `Accept build-ready AppSpec for builder-reviewed-proof:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();

    await session.send("Prepare target dependencies.");
    t.succeeded();

    await session.send("Run target identity and planning.");
    t.succeeded();

    await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn1.message, includes("private preview"));
    t.check(turn1.message, staysProductFacing);

    const validation = await session.send("Validate the applied creation.");

    validation.notEvent("input.requested");
    t.succeeded();
    t.check(validation.message, includes("quality checks"));
    t.check(validation.message, staysProductFacing);

    await session.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });

    const review = await session.send("Accept the displayed change set.");

    review.notEvent("input.requested");
    t.succeeded();
    t.check(review.message, includes("ready for review"));
    t.check(review.message, includes("draft pull request"));
    t.check(review.message, staysProductFacing);

    const turn2 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(turn2.message, includes('"phase":"reviewed"'));

    session.eventsSatisfy(
      "persisted workflow contains actual planning receipts and successful validation/review",
      (events) =>
        events.some((event) => {
          if (
            event.type !== "action.result" ||
            event.data.result.kind !== "tool-result" ||
            event.data.result.toolName !== "artifact_workflow_status"
          ) {
            return false;
          }
          return reviewedStateSchema.safeParse(event.data.result.output).success;
        }),
    );

    for (const tool of [
      "inspect_source",
      "prepare_workspace",
      "record_prototype_artifact",
      "accept_app_spec",
      "apply_app_creation",
      "validate_app_creation",
      "change_set_status",
      "accept_change_set",
    ]) {
      t.calledTool(tool, { count: 1 });
    }

    for (const tool of [
      "publish_reviewed_change_set",
      "publish_reviewed_change_set_to_branch_worktree",
      "publish_fresh_repository",
      "publish_github_draft_pr",
      "create_github_repository",
      "bash",
      "write_file",
    ]) {
      t.notCalledTool(tool);
    }
  },
  // Include measured cold shared toolchain preparation before workflow assertions.
  timeoutMs: 600_000,
});
