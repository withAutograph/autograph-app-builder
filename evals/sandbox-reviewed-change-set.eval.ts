import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

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

const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export default defineEval({
  description:
    "The current Vercel Sandbox applies and validates one supported-source proposal, then records the reviewed change set without publication.",
  tags: ["sandbox-integration", "reviewed-change-set"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The supported source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send(`Accept build-ready AppSpec for builder-reviewed-proof:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();

    await t.send("Prepare target dependencies.");
    t.succeeded();

    await t.send("Run target identity and planning.");
    t.succeeded();

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
    t.check(t.reply, staysProductFacing);

    await t.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });

    const review = await t.send("Accept the displayed change set.");
    review.notEvent("input.requested");
    t.succeeded();
    t.check(t.reply, includes("ready for review"));
    t.check(t.reply, includes("draft pull request"));
    t.check(t.reply, staysProductFacing);

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
