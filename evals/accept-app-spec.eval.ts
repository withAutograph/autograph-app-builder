import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "AppSpec acceptance and fixed target identity/planning have distinct approvals and durable receipts.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Assess workspace readiness before planning.");
    t.succeeded();
    t.calledTool("workspace_readiness_status", { count: 1 });
    t.check(t.reply, includes("not ready for target execution"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.requireInputRequest({ toolName: "accept_app_spec" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("separate explicit request and approval"));

    await t.send("Prepare offline target dependencies.");
    t.requireInputRequest({ toolName: "prepare_target_dependencies" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("target-bound offline dependency closure"));
    t.check(t.reply, includes("builder-owned planning metadata"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Prepare offline target dependencies after a lost response.");
    t.requireInputRequest({ toolName: "prepare_target_dependencies" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable dependency-preparation receipt"),
    );

    await t.send(
      "Prepare offline target dependencies with a stale AppSpec digest.",
    );
    t.requireInputRequest({ toolName: "prepare_target_dependencies" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(
      t.reply,
      includes("Stale offline dependency preparation was rejected"),
    );

    await t.send("Run target identity and planning.");
    t.requireInputRequest({ toolName: "plan_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("accept_app_spec", { count: 1 });
    t.calledTool("plan_app_creation", { count: 2 });
    t.check(t.reply, includes("target identity and planning commands"));
    t.check(t.reply, includes("no apply, validation, or target mutation"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target planning after a lost response.");
    t.requireInputRequest({ toolName: "plan_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable target-planning receipt"),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target planning with a stale AppSpec digest.");
    t.requireInputRequest({ toolName: "plan_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("stale target-planning retry was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Read recorded prototype artifact.");
    t.succeeded();
    t.calledTool("get_prototype_artifact", { count: 1 });
    t.check(t.reply, includes("content-addressed prototype artifact was read"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Read recorded prototype artifact with stale digest.");
    t.succeeded();
    t.calledTool("get_prototype_artifact", { count: 1 });
    t.check(t.reply, includes("digest was rejected as stale"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send(
      "Assess target command readiness for the current creation proposal.",
    );
    t.succeeded();
    t.calledTool("target_execution_status", { count: 1 });
    t.check(t.reply, includes("ready for a future typed target command"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Assess target command readiness with stale proposal digest.");
    t.succeeded();
    t.calledTool("target_execution_status", { count: 1 });
    t.check(t.reply, includes("rejected the stale proposal"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Apply the current creation proposal.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("fresh builder-owned overlay"));
    t.check(t.reply, includes("exact pre/post tree"));
    t.check(t.reply, includes("Validation"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target apply after a lost response.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("reused the exact durable target-apply receipt"));
    t.check(t.reply, includes("command was not rerun"));

    await t.send("Apply with a stale proposal digest.");
    t.requireInputRequest({ toolName: "apply_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("Stale target apply was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Validate the applied creation.");
    t.requireInputRequest({ toolName: "validate_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("fixed check and test commands passed"));
    t.check(t.reply, includes("independent builder-owned copies"));
    t.check(t.reply, includes("change review and publication did not run"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target validation after a lost response.");
    t.requireInputRequest({ toolName: "validate_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable target-validation receipt"),
    );
    t.check(t.reply, includes("neither fixed command was rerun"));

    await t.send("Validate with a stale apply digest.");
    t.requireInputRequest({ toolName: "validate_app_creation" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("Stale target validation was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });
    t.check(t.reply, includes("Validated change-set proposal"));
    t.check(t.reply, includes("approvedPaths"));
    t.check(t.reply, includes('"changes"'));
    t.check(t.reply, includes('"kind"'));
    t.check(t.reply, includes('"before"'));
    t.check(t.reply, includes('"after"'));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Accept the displayed change set.");
    t.requireInputRequest({
      toolName: "accept_change_set",
      input: (input) => {
        const changeSet = (input as { changeSet?: unknown }).changeSet;
        if (typeof changeSet !== "object" || changeSet === null) return false;
        const value = changeSet as {
          digest?: unknown;
          approvedPaths?: unknown;
          changes?: unknown;
        };
        if (
          typeof value.digest !== "string" ||
          !Array.isArray(value.approvedPaths) ||
          !Array.isArray(value.changes)
        )
          return false;
        const approvedPaths: unknown[] = value.approvedPaths;
        const changes: unknown[] = value.changes;
        return (
          changes.length === approvedPaths.length &&
          changes.every(
            (change, index) =>
              typeof change === "object" &&
              change !== null &&
              "path" in change &&
              "kind" in change &&
              approvedPaths[index] === change.path &&
              (change.kind === "added" ||
                change.kind === "modified" ||
                change.kind === "deleted") &&
              ((change.kind === "added" && "after" in change) ||
                (change.kind === "deleted" && "before" in change) ||
                (change.kind === "modified" &&
                  "before" in change &&
                  "after" in change)),
          )
        );
      },
    });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("separately approved normalized change set"));
    t.check(t.reply, includes("Publication did not run"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry change-set acceptance after a lost response.");
    t.requireInputRequest({ toolName: "accept_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable reviewed change-set receipt"),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Accept a stale change set.");
    t.requireInputRequest({ toolName: "accept_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("stale change-set proposal was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Publish reviewed change set locally.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("cancel");
    t.succeeded();
    t.check(t.reply, includes("canceled or rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Publish reviewed change set locally after cancellation.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("named existing local checkout"));
    t.check(t.reply, includes("No commit, branch, GitHub publication"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry local publication after a lost response.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable local-publication receipt"),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Publish reviewed change set with stale review digest.");
    t.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("Stale local publication was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Record a replacement prototype artifact.");
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("durable state was not changed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(t.reply, includes('"phase":"published_local"'));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          reply.includes('"review"') &&
          reply.includes('"publication"'),
        "published workflow retains exact review and publication receipts",
      ),
    );
    const afterRevision = t.reply;

    await t.send("Retry recording the exact replacement prototype artifact.");
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("durable state was not changed"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, equals(afterRevision));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const topologyPath = join(repository, "apps/shell/microfrontends.json");
    const topologyBeforeOverlap = await readFile(topologyPath);
    await writeFile(topologyPath, "concurrent overlap\n");
    await t.send("Publish reviewed change set locally with dirty overlap.");
    t.succeeded();
    t.check(t.reply, includes("preconditions were rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    await writeFile(topologyPath, topologyBeforeOverlap);
  },
});
