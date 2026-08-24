import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";

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

    await t.send("Record a replacement prototype artifact.");
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("invalidated the accepted AppSpec and proposal"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(t.reply, includes('"phase":"prepared"'));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !reply.includes('"appSpec"') &&
          !reply.includes('"dependencies"') &&
          !reply.includes('"proposal"'),
        "downstream AppSpec, dependency, and proposal receipts were invalidated",
      ),
    );
    const afterRevision = t.reply;

    await t.send("Retry recording the exact replacement prototype artifact.");
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.succeeded();
    t.check(t.reply, includes("reused the exact stored artifact revision"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, equals(afterRevision));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
