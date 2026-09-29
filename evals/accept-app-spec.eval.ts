import { defineEval, type EveEvalTurn } from "eve/evals";
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
    let turn: EveEvalTurn;
    const repository = createSupportedRepositoryFixture();

    turn = await session.send(`Prepare supported repository at ${repository}`);
    t.succeeded();

    turn = await session.send("Assess workspace readiness before planning.");
    t.succeeded();
    t.calledTool("workspace_readiness_status", { count: 1 });
    t.check(turn.message, includes("not ready for target execution"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send(`Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();
    t.check(turn.message, includes("ready for automatic implementation planning"));

    turn = await session.send("Prepare offline target dependencies.");
    t.succeeded();
    t.check(turn.message, includes("Checkout-backed dependency metadata"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Prepare offline target dependencies after a lost response.");
    t.succeeded();
    t.check(turn.message, includes("reused the exact durable dependency-preparation receipt"));

    turn = await session.send("Run target identity and planning.");
    t.succeeded();
    t.calledTool("accept_app_spec", { count: 1 });
    t.check(turn.message, includes("private preview"));
    t.check(
      turn.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/target identity|canonical proposal|digest-bound|target mutation/iu.test(reply),
        "planning result stays product-facing",
      ),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Retry target planning after a lost response.");
    t.succeeded();
    t.check(turn.message, includes("reused the exact durable target-planning receipt"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Read recorded prototype artifact.");
    t.succeeded();
    t.calledTool("get_prototype_artifact", { count: 1 });
    t.check(turn.message, includes("content-addressed prototype artifact was read"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Read recorded prototype artifact with stale digest.");
    t.succeeded();
    t.calledTool("get_prototype_artifact", { count: 1 });
    t.check(turn.message, includes("digest was rejected as stale"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Apply the current creation proposal.");
    session.requireInputRequest({ toolName: "apply_app_creation" });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("private preview"));
    t.check(turn.message, includes("quality checks"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const retryApply = turn = await session.send("Retry target apply after a lost response.");
    t.succeeded();
    retryApply.notEvent("input.requested");
    retryApply.calledTool("apply_app_creation", { count: 1 });
    t.check(turn.message, includes("prepared app is unchanged"));

    const validation = turn = await session.send("Validate the applied creation.");
    t.succeeded();
    validation.notEvent("input.requested");
    t.check(turn.message, includes("quality checks"));
    t.check(turn.message, includes("ready for review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const retryValidation = turn = await session.send("Retry target validation after a lost response.");
    t.succeeded();
    retryValidation.notEvent("input.requested");
    t.check(turn.message, includes("quality checks are still passing"));

    turn = await session.send("Inspect the validated change set.");
    t.succeeded();
    t.calledTool("change_set_status", { count: 1 });
    t.check(turn.message, includes("completed app changes are ready for review"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const review = turn = await session.send("Accept the displayed change set.");
    t.succeeded();
    review.notEvent("input.requested");
    t.check(turn.message, includes("completed app changes are ready for review"));
    t.check(turn.message, includes("draft pull request"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const retryReview = turn = await session.send("Retry change-set acceptance after a lost response.");
    t.succeeded();
    retryReview.notEvent("input.requested");
    t.check(turn.message, includes("same completed app changes remain ready"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Publish reviewed change set locally.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("cancel");
    t.succeeded();
    t.check(turn.message, includes("canceled or rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Publish reviewed change set locally after cancellation.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("named existing local checkout"));
    t.check(turn.message, includes("No commit, branch, GitHub publication"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Retry local publication after a lost response.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("reused the exact durable local-publication receipt"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Publish reviewed change set with stale review digest.");
    session.requireInputRequest({ toolName: "publish_reviewed_change_set" });
    turn = await session.respondAll("approve");
    t.succeeded();
    t.check(turn.message, includes("Stale local publication was rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Record a replacement prototype artifact.");
    t.succeeded();
    t.check(turn.message, includes("durable state was not changed"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 2 });
    t.check(turn.message, includes('"phase":"published_local"'));
    t.check(
      turn.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          reply.includes('"review"') &&
          reply.includes('"publication"'),
        "published workflow retains exact review and publication receipts",
      ),
    );
    const afterRevision = turn.message;

    turn = await session.send("Retry recording the exact replacement prototype artifact.");
    t.succeeded();
    t.check(turn.message, includes("durable state was not changed"));

    turn = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn.message, equals(afterRevision));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    const topologyPath = path.join(repository, "microfrontends.json");
    const topologyBeforeOverlap = await readFile(topologyPath);
    await writeFile(topologyPath, "concurrent overlap\n");
    turn = await session.send("Publish reviewed change set locally with dirty overlap.");
    t.succeeded();
    t.check(turn.message, includes("preconditions were rejected"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    await writeFile(topologyPath, topologyBeforeOverlap);
  },
  timeoutMs: 300_000,
});
