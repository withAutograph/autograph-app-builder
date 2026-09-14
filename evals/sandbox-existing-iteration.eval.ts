import { createHash } from "node:crypto";
import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { isProductFacing } from "./support/public-conversation";

const staysProductFacing = satisfies(
  (reply) =>
    isProductFacing(reply) &&
    !/(?:sandbox|image|receipt|dependency cache|publication did not run)/iu.test(String(reply)),
  "assistant reply stays product-facing during existing-app iteration",
);

const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export default defineEval({
  description:
    "The current Vercel Sandbox inspects and edits the existing Vendor application through review without publication.",
  tags: ["sandbox-integration", "existing-app-iteration"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The supported source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();
    await t.send(`Update the Vendor review so operations can see when tax verification is required.
Accept build-ready AppSpec for vendor:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();
    t.calledTool("inspect_existing_app", { count: 2 });
    t.calledTool("accept_app_spec", {
      count: 1,
      input: {
        existingAppChanges: (value) =>
          Array.isArray(value) &&
          value.length > 0 &&
          value.every(
            (change) =>
              typeof change === "object" &&
              change !== null &&
              "path" in change &&
              typeof change.path === "string" &&
              change.path.startsWith("apps/vendor/") &&
              "content" in change &&
              typeof change.content === "string" &&
              change.content.includes('data-vendor-review-status="tax-verification"') &&
              change.content.includes("Tax verification required"),
          ),
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
    t.check(t.reply, includes("quality checks"));
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
          )
            return false;
          const state = event.data.result.output as {
            phase?: string;
            dependencies?: { digest?: string };
            identity?: { digest?: string };
            proposal?: { digest?: string };
            apply?: { digest?: string; status?: string };
            validation?: { digest?: string; status?: string };
            review?: { digest?: string; changeSetDigest?: string };
          };
          return (
            state?.phase === "reviewed" &&
            [state.dependencies?.digest, state.identity?.digest, state.proposal?.digest].every(
              digest,
            ) &&
            state.apply?.status === "applied" &&
            digest(state.apply.digest) &&
            state.validation?.status === "passed" &&
            digest(state.validation.digest) &&
            digest(state.review?.digest) &&
            digest(state.review?.changeSetDigest)
          );
        }),
    );

    t.eventsSatisfy(
      "reviewed Vendor diff contains the requested tax-verification change",
      (events) => {
        const inspected: { path: string; content: string }[] = [];
        const changes: { path: string; after?: { digest?: string } }[] = [];
        for (const event of events) {
          if (event.type !== "action.result" || event.data.result.kind !== "tool-result") continue;
          const { result } = event.data;
          if (result.toolName === "inspect_existing_app") {
            const output = result.output as { files?: { path: string; content: string }[] };
            inspected.push(...(output?.files ?? []));
          }
          if (result.toolName === "change_set_status") {
            const output = result.output as {
              changes?: { path: string; after?: { digest?: string } }[];
            };
            changes.push(...(output?.changes ?? []));
          }
        }
        return inspected.some(({ path, content }) => {
          if (!path.startsWith("apps/vendor/")) return false;
          const expected = content.replace(
            /(?<opening>return\s*\(\s*<(?:main|div|section)\b[^>]*>)/u,
            (opening) =>
              `${opening}\n<p data-vendor-review-status="tax-verification">Tax verification required</p>`,
          );
          if (expected === content) return false;
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
    ])
      t.calledTool(tool, { count: 1 });

    for (const tool of [
      "publish_reviewed_change_set",
      "publish_reviewed_change_set_to_branch_worktree",
      "publish_fresh_repository",
      "publish_github_draft_pr",
      "create_github_repository",
      "bash",
      "write_file",
    ])
      t.notCalledTool(tool);
  },
  timeoutMs: 360_000,
});
