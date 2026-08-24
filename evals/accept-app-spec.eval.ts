import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "AppSpec acceptance is approval-bound and yields a durable read-only proposal without executing target commands.",
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
    t.calledTool("accept_app_spec", { count: 1 });
    t.calledTool("plan_app_creation", { count: 1 });
    t.check(t.reply, includes("digest-bound read-only creation proposal"));
    t.check(t.reply, includes("No target command has run"));

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
    t.check(t.reply, includes("not ready for a target command"));
    t.check(t.reply, includes("no target command was run"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Assess target command readiness with stale proposal digest.");
    t.succeeded();
    t.calledTool("target_execution_status", { count: 1 });
    t.check(t.reply, includes("rejected the stale proposal"));
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
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(t.reply, includes('"phase":"prepared"'));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !reply.includes('"appSpec"') &&
          !reply.includes('"proposal"'),
        "downstream AppSpec and proposal receipts were invalidated",
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
