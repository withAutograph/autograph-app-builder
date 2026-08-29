import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Internal product-plan validation and fixed read-only planning are automatic while target mutation remains approval-bound.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
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
    t.succeeded();
    t.check(t.reply, includes("ready for automatic implementation planning"));

    await t.send("Prepare offline target dependencies.");
    t.succeeded();
    t.check(t.reply, includes("target-bound offline dependency closure"));
    t.check(t.reply, includes("builder-owned planning metadata"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Prepare offline target dependencies after a lost response.");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable dependency-preparation receipt"),
    );

    await t.send(
      "Prepare offline target dependencies with a stale AppSpec digest.",
    );
    t.succeeded();
    t.check(
      t.reply,
      includes("Stale offline dependency preparation was rejected"),
    );

    await t.send("Run target identity and planning.");
    t.succeeded();
    t.calledTool("accept_app_spec", { count: 1 });
    t.calledTool("plan_app_creation", { count: 2 });
    t.check(t.reply, includes("target identity and planning commands"));
    t.check(t.reply, includes("no apply, validation, or target mutation"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target planning after a lost response.");
    t.succeeded();
    t.check(
      t.reply,
      includes("reused the exact durable target-planning receipt"),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target planning with a stale AppSpec digest.");
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
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("private preview"));
    t.check(t.reply, includes("quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target apply after a lost response.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("prepared app is unchanged"));

    await t.send("Apply with a stale proposal digest.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("product plan changed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Validate the applied creation.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("quality checks"));
    t.check(t.reply, includes("ready for review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry target validation after a lost response.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("quality checks are still passing"));

    await t.send("Validate with a stale apply digest.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("app changed before checks could start"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });
    t.check(t.reply, includes("completed app changes are ready for review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Accept the displayed change set.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("completed app changes are ready for review"));
    t.check(t.reply, includes("Nothing has been published"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Retry change-set acceptance after a lost response.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("same completed app changes remain ready"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Accept a stale change set.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(t.reply, includes("app changed before review could finish"));
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
    t.succeeded();
    t.check(t.reply, includes("durable state was not changed"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, equals(afterRevision));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const topologyPath = join(repository, "microfrontends.json");
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
