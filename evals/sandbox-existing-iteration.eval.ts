import { createHash } from "node:crypto";
import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { z } from "zod";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { isProductFacing } from "./support/public-conversation";

const staysProductFacing = satisfies(
  (reply) =>
    isProductFacing(reply) &&
    !/(?:sandbox|image|receipt|dependency cache|publication did not run)/iu.test(String(reply)),
  "assistant reply stays product-facing during existing-app iteration",
);

const validatedCallSchema = z.object({
  output: z.object({ status: z.literal("validated") }),
  status: z.literal("completed"),
});

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const existingChangesSchema = z
  .array(
    z.object({
      content: z
        .string()
        .includes('data-vendor-review-status="tax-verification"')
        .includes("Tax verification required"),
      path: z.string().startsWith("apps/vendor/"),
    }),
  )
  .min(1);
const reviewedStateSchema = z.object({
  apply: z.object({ digest: digestSchema, status: z.literal("applied") }),
  dependencies: z.object({ digest: digestSchema }),
  identity: z.object({ digest: digestSchema }),
  phase: z.literal("reviewed"),
  proposal: z.object({ digest: digestSchema }),
  review: z.object({ changeSetDigest: digestSchema, digest: digestSchema }),
  validation: z.object({ digest: digestSchema, status: z.literal("passed") }),
});
const inspectedOutputSchema = z.object({
  files: z.array(z.object({ content: z.string(), path: z.string() })).optional(),
});
const changeSetOutputSchema = z.object({
  changes: z
    .array(z.object({ after: z.object({ digest: z.string() }).optional(), path: z.string() }))
    .optional(),
});

export default defineEval({
  description:
    "The current Vercel Sandbox inspects and edits the existing Vendor application through review without publication.",
  tags: ["sandbox-integration", "existing-app-iteration"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0) {
      throw new Error("The supported source root is missing.");
    }

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();
    await t.send(`Update the Vendor review so operations can see when tax verification is required.
Accept build-ready AppSpec for vendor:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();
    t.calledTool("inspect_existing_app", { count: 2 });
    t.calledTool("accept_app_spec", {
      count: 1,
      input: {
        existingAppChanges: (value) => existingChangesSchema.safeParse(value).success,
      },
    });
    await t.send("Prepare target dependencies.");
    t.succeeded();
    await t.send("Run target identity and planning.");
    t.succeeded();
    t.check(t.reply, includes("tax verification is required"));
    await t.send("Apply the current creation proposal.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("private preview"));
    t.check(t.reply, staysProductFacing);
    const validation = await t.send("Validate the applied creation.");
    validation.notEvent("input.requested");
    t.succeeded();
    t.check(t.reply, includes("passed its local quality checks"));
    const validationCall = validation.requireToolCall("validate_app_creation");
    await t.require(
      validationCall,
      satisfies(
        (call) => validatedCallSchema.safeParse(call).success,
        "current validation receipt passed",
      ),
    );
    await t.send("Inspect the validated change set.");
    t.succeeded();
    const review = await t.send("Accept the displayed change set.");
    review.notEvent("input.requested");
    t.succeeded();
    t.check(t.reply, includes("ready for review"));
    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(t.reply, includes('"phase":"reviewed"'));

    t.eventsSatisfy(
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

    t.eventsSatisfy(
      "reviewed Vendor diff contains the requested tax-verification change",
      (events) => {
        const inspected: { path: string; content: string }[] = [];
        const changes: { path: string; after?: { digest?: string } }[] = [];
        for (const event of events) {
          if (event.type !== "action.result" || event.data.result.kind !== "tool-result") {
            continue;
          }
          const { result } = event.data;
          if (result.toolName === "inspect_existing_app") {
            const output = inspectedOutputSchema.safeParse(result.output);
            if (output.success) {
              inspected.push(...(output.data.files ?? []));
            }
          }
          if (result.toolName === "change_set_status") {
            const output = changeSetOutputSchema.safeParse(result.output);
            if (output.success) {
              changes.push(...(output.data.changes ?? []));
            }
          }
        }
        return inspected.some(({ path, content }) => {
          if (!path.startsWith("apps/vendor/")) {
            return false;
          }
          const expected = content.replace(
            /(?<opening>return\s*\(\s*<(?:main|div|section)\b[^>]*>)/u,
            (opening) =>
              `${opening}\n<p data-vendor-review-status="tax-verification">Tax verification required</p>`,
          );
          if (expected === content) {
            return false;
          }
          const expectedDigest = createHash("sha256").update(expected).digest("hex");
          return changes.some(
            (change) => change.path === path && change.after?.digest === expectedDigest,
          );
        });
      },
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
  timeoutMs: 360_000,
});
