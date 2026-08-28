import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A sparse vendor-onboarding brief infers identity and UX, automatically prepares eligible context, repairs its internal spec, and reaches a validated plan without conversation-friction input.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Supported repository at ${repository}
Product brief: Build an internal vendor-onboarding workflow for operations to review new vendor submissions, resolve missing information, and involve Finance when tax verification is actually required.`);

    t.succeeded();
    t.notEvent("input.requested");
    t.toolOrder([
      "inspect_source",
      "prepare_workspace",
      "record_prototype_artifact",
      "accept_app_spec",
      "record_prototype_artifact",
      "accept_app_spec",
      "prepare_target_dependencies",
      "plan_app_creation",
    ]);
    t.calledTool("inspect_source", { count: 1 });
    t.calledTool("prepare_workspace", { count: 1 });
    t.calledTool("record_prototype_artifact", {
      input: {
        path: "prototype/vendor-onboarding/index.html",
        mediaType: "text/html",
        content: (value) =>
          typeof value === "string" &&
          value.includes("Operations review queue") &&
          value.includes("Finance: verify tax information") &&
          value.includes('id="detail-title"'),
      },
      count: 1,
    });
    t.calledTool("record_prototype_artifact", {
      input: { path: "prototype/vendor-onboarding/decisions.md" },
      count: 1,
    });
    t.calledTool("record_prototype_artifact", {
      input: {
        path: "prototype/vendor-onboarding/app-spec.md",
        content: (value) =>
          typeof value === "string" && !value.includes("## Build handoff"),
      },
      count: 1,
    });
    t.calledTool("record_prototype_artifact", {
      input: {
        path: "prototype/vendor-onboarding/app-spec.md",
        content: (value) =>
          typeof value === "string" &&
          value.includes("## Build handoff") &&
          value.includes('"status": "build-ready"'),
      },
      count: 1,
    });
    t.calledTool("accept_app_spec", { status: "failed", count: 1 });
    t.calledTool("accept_app_spec", { count: 1 });
    t.calledTool("prepare_target_dependencies", { count: 1 });
    t.calledTool("plan_app_creation", { count: 1 });
    t.notCalledTool("apply_app_creation");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(t.reply, includes("Vendor Onboarding"));
    t.check(t.reply, includes("`vendor-onboarding`"));
    t.check(t.reply, includes("operations review queue"));
    t.check(t.reply, includes("vendor detail panel"));
    t.check(t.reply, includes("conditional Finance verification step"));
    t.check(
      t.reply,
      includes("usable visual prototype and validated implementation plan"),
    );
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          isProductFacing(reply) &&
          !/(?:no mutation|nothing was (?:created|written)|[0-9a-f]{40})/iu.test(
            String(reply),
          ) &&
          !/\b(?:queue|form|dashboard)\?/iu.test(String(reply)),
        "assistant reply stays product-facing and does not ask identity or interface-selection questions",
      ),
    );
    t.eventsSatisfy(
      "all public assistant messages omit routine source and authority mechanics",
      (events) => {
        const messages = events.flatMap((event) =>
          event.type === "message.completed" &&
          typeof event.data.message === "string"
            ? [event.data.message]
            : [],
        );
        return (
          messages.length > 0 &&
          messages.every(
            (assistantMessage) =>
              isProductFacing(assistantMessage) &&
              !/(?:no mutation|nothing was (?:created|written)|[0-9a-f]{40})/iu.test(
                assistantMessage,
              ),
          )
        );
      },
    );
  },
});
