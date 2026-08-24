import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Artifact recording is approval-bound; cancellation cannot mutate durable artifact state.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();

    await t.send(`Prepare supported repository at ${repository}`);
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send(
      `Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`,
    );
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("approve");
    t.requireInputRequest({ toolName: "accept_app_spec" });
    await t.respondAll("approve");
    t.succeeded();

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    const beforeCancellation = t.reply;

    await t.send("Record a replacement prototype artifact.");
    t.requireInputRequest({ toolName: "record_prototype_artifact" });
    await t.respondAll("cancel");
    t.succeeded();
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(t.reply, includes("canceled"));

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.calledTool("artifact_workflow_status", { count: 1 });
    t.check(t.reply, equals(beforeCancellation));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
