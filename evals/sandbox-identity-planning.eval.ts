import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { z } from "zod";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const plannedStateSchema = z.object({
  dependencies: z.object({ digest: digestSchema }),
  identity: z.object({ digest: digestSchema }),
  phase: z.literal("planned"),
  proposal: z.object({ digest: digestSchema }),
});

export default defineEval({
  description:
    "The current Vercel Sandbox prepares supported source and reaches only the typed planned phase.",
  tags: ["sandbox-integration"],
  async test(t) {
    const repository = process.env.REPOSITORY_LOCAL_ROOTS;
    if (repository === undefined || repository.length === 0) {
      throw new Error("The supported source root is missing.");
    }

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
        ) {
          return false;
        }
        return plannedStateSchema.safeParse(event.data.result.output).success;
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
    ]) {
      t.notCalledTool(tool);
    }
  },
  // Include measured cold shared toolchain preparation before workflow assertions.
  timeoutMs: 600_000,
});
