import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";

const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export default defineEval({
  description:
    "The current Vercel Sandbox prepares supported source and reaches only the typed planned phase.",
  tags: ["sandbox-integration"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0)
      throw new Error("The supported source root is missing.");

    await t.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    await t.send(`Accept build-ready AppSpec for builder-proof:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();

    await t.send("Prepare target dependencies.");
    t.succeeded();

    await t.send("Run target identity and planning.");
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(t.reply, includes('"phase":"planned"'));

    t.eventsSatisfy("persisted workflow contains actual planning receipts", (events) =>
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
          state?.phase === "planned" &&
          digest(state.dependencies?.digest) &&
          digest(state.identity?.digest) &&
          digest(state.proposal?.digest)
        );
      }),
    );

    t.calledTool("inspect_source", { count: 1 });
    t.calledTool("prepare_workspace", { count: 1 });
    t.calledTool("record_prototype_artifact", { count: 1 });
    t.calledTool("accept_app_spec", { count: 1 });
    t.notEvent("input.requested");
    for (const tool of [
      "apply_app_creation",
      "validate_app_creation",
      "accept_change_set",
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
});
