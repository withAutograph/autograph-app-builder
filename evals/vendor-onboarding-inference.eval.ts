import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "A sparse vendor-onboarding brief infers identity and UX, automatically prepares eligible context, repairs its internal spec, and reaches review-ready app changes without conversation-friction input.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Supported repository at ${repository}
Product brief: Build an internal vendor-onboarding workflow for operations to review new vendor submissions, resolve missing information, and involve Finance when tax verification is actually required.`);

    t.requireInputRequest({ toolName: "apply-app-creation" });
    t.event("input.requested", { count: 1 });
    await t.respondAll("approve");
    t.succeeded();
    t.toolOrder([
      "inspect-source",
      "prepare-workspace",
      "record-prototype-artifact",
      "accept-app-spec",
      "record-prototype-artifact",
      "accept-app-spec",
      "plan-app-creation",
      "apply-app-creation",
      "validate-app-creation",
      "change-set-status",
      "accept-change-set",
    ]);
    t.calledTool("inspect-source", { count: 1 });
    t.calledTool("prepare-workspace", { count: 1 });
    t.calledTool("record-prototype-artifact", {
      count: 1,
      input: {
        content: (value) =>
          typeof value === "string" &&
          value.includes("Operations review queue") &&
          value.includes("Finance: verify tax information") &&
          value.includes('id="detail-title"'),
        mediaType: "text/html",
        path: "prototype/vendor-onboarding/index.html",
      },
    });
    t.calledTool("record-prototype-artifact", {
      count: 1,
      input: { path: "prototype/vendor-onboarding/decisions.md" },
    });
    t.calledTool("record-prototype-artifact", {
      count: 1,
      input: {
        content: (value) => typeof value === "string" && !value.includes("## Build handoff"),
        path: "prototype/vendor-onboarding/app-spec.md",
      },
    });
    t.calledTool("record-prototype-artifact", {
      count: 1,
      input: {
        content: (value) =>
          typeof value === "string" &&
          value.includes("## Build handoff") &&
          value.includes('"status": "build-ready"'),
        path: "prototype/vendor-onboarding/app-spec.md",
      },
    });
    t.calledTool("accept-app-spec", { count: 1, status: "failed" });
    t.calledTool("accept-app-spec", { count: 1 });
    t.notCalledTool("prepare-target-dependencies");
    t.calledTool("plan-app-creation", { count: 1 });
    t.calledTool("apply-app-creation", { count: 1 });
    t.calledTool("validate-app-creation", { count: 1 });
    t.calledTool("change-set-status", { count: 1 });
    t.calledTool("accept-change-set", { count: 1 });
    t.notCalledTool("publish-reviewed-change-set");
    t.notCalledTool("publish-reviewed-change-set_to_branch_worktree");
    t.notCalledTool("publish-github-draft-pr");
    t.notCalledTool("agent");
    t.notCalledTool("bash");
    t.notCalledTool("write-file");
    t.check(t.reply, includes("Vendor Onboarding"));
    t.check(t.reply, includes("`vendor-onboarding`"));
    t.check(t.reply, includes("operations review queue"));
    t.check(t.reply, includes("vendor detail panel"));
    t.check(t.reply, includes("conditional Finance verification step"));
    t.check(t.reply, includes("implementation plan and complete app changes"));
    t.check(t.reply, includes("ready to review"));
    t.check(t.reply, includes("draft pull request"));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          isProductFacing(reply) &&
          !/(?:no mutation|nothing was (?:created|written)|[0-9a-f]{40})/iu.test(String(reply)) &&
          !/\b(?:queue|form|dashboard)\?/iu.test(String(reply)),
        "assistant reply stays product-facing and does not ask identity or interface-selection questions",
      ),
    );
    t.eventsSatisfy(
      "all public assistant messages omit routine source and authority mechanics",
      (events) => {
        const messages = events.flatMap((event) =>
          event.type === "message.completed" && typeof event.data.message === "string"
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
