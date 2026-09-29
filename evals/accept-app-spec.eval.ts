import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Internal product-plan validation and fixed read-only planning are automatic while target mutation remains approval-bound.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();

    await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    const turn1 = await session.send("Assess workspace readiness before planning.");
    t.succeeded();
    t.calledTool("workspace_readiness_status", { count: 1 });
    t.check(turn1.message, includes("not ready for target execution"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn2 = await session.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.succeeded();
    t.check(turn2.message, includes("ready for automatic implementation planning"));

    const turn3 = await session.send("Prepare offline target dependencies.");
    t.succeeded();
    t.check(turn3.message, includes("Checkout-backed dependency metadata"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn4 = await session.send("Prepare offline target dependencies after a lost response.");
    t.succeeded();
    t.check(turn4.message, includes("reused the exact durable dependency-preparation receipt"));

    const turn5 = await session.send("Run target identity and planning.");
    t.succeeded();
    t.calledTool("accept_app_spec", { count: 1 });
    t.check(turn5.message, includes("private preview"));
    t.check(
      turn5.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/target identity|canonical proposal|digest-bound|target mutation/iu.test(reply),
        "planning result stays product-facing",
      ),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn6 = await session.send("Retry target planning after a lost response.");
    t.succeeded();
    t.check(turn6.message, includes("reused the exact durable target-planning receipt"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn7 = await session.send("Read recorded prototype artifact.");
    t.succeeded();
    t.calledTool("get_prototype_artifact", { count: 1 });
    t.check(turn7.message, includes("content-addressed prototype artifact was read"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn8 = await session.send("Read recorded prototype artifact with stale digest.");
    t.succeeded();
    t.calledTool("get_prototype_artifact", { count: 1 });
    t.check(turn8.message, includes("digest was rejected as stale"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    const turn9 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn9.message, includes("private preview"));
    t.check(turn9.message, includes("quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const retryApply = await session.send("Retry target apply after a lost response.");

    t.succeeded();
    retryApply.notEvent("input.requested");
    retryApply.calledTool("apply_app_creation", { count: 1 });
    t.check(retryApply.message, includes("prepared app is unchanged"));

    const validation = await session.send("Validate the applied creation.");

    t.succeeded();
    validation.notEvent("input.requested");
    t.check(validation.message, includes("quality checks"));
    t.check(validation.message, includes("ready for review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const retryValidation = await session.send("Retry target validation after a lost response.");

    t.succeeded();
    retryValidation.notEvent("input.requested");
    t.check(retryValidation.message, includes("quality checks are still passing"));

    const turn10 = await session.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });
    t.check(turn10.message, includes("completed app changes are ready for review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const review = await session.send("Accept the displayed change set.");

    t.succeeded();
    review.notEvent("input.requested");
    t.check(review.message, includes("completed app changes are ready for review"));
    t.check(review.message, includes("draft pull request"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const retryReview = await session.send("Retry change-set acceptance after a lost response.");

    t.succeeded();
    retryReview.notEvent("input.requested");
    t.check(retryReview.message, includes("same completed app changes remain ready"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    const turn11 = await session.respondAll("cancel");
    t.succeeded();
    t.check(turn11.message, includes("canceled or rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await session.send("Publish reviewed change set locally after cancellation.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    const turn12 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn12.message, includes("named existing local checkout"));
    t.check(turn12.message, includes("No commit, branch, GitHub publication"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await session.send("Retry local publication after a lost response.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    const turn13 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn13.message, includes("reused the exact durable local-publication receipt"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await session.send("Publish reviewed change set with stale review digest.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    const turn14 = await session.respondAll("approve");
    t.succeeded();
    t.check(turn14.message, includes("Stale local publication was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn15 = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.check(turn15.message, includes("durable state was not changed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const turn16 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(turn16.message, includes('"phase":"published_local"'));
    t.check(
      turn16.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          reply.includes('"review"') &&
          reply.includes('"publication"'),
        "published workflow retains exact review and publication receipts",
      ),
    );
    const afterRevision = turn16.message;

    const turn17 = await session.send("Retry recording the exact replacement prototype artifact.");
    t.succeeded();
    t.check(turn17.message, includes("durable state was not changed"));

    const turn18 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn18.message, equals(afterRevision));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const topologyPath = path.join(repository, "microfrontends.json");
    const topologyBeforeOverlap = await readFile(topologyPath);
    await writeFile(topologyPath, "concurrent overlap\n");
    const turn19 = await session.send("Publish reviewed change set locally with dirty overlap.");
    t.succeeded();
    t.check(turn19.message, includes("preconditions were rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    await writeFile(topologyPath, topologyBeforeOverlap);
  },
  timeoutMs: 300_000,
});
