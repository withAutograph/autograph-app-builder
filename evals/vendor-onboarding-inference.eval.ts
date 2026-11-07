import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { z } from "zod";

import { isProductFacing } from "./support/public-conversation";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

const stringInputSchema = z.string();
const completedMessageEventSchema = z.object({
  data: z.object({ message: z.string() }),
  type: z.literal("message.completed"),
});

export default defineEval({
  description:
    "A sparse vendor-onboarding brief infers identity and UX, automatically prepares eligible context, repairs its internal spec, and reaches review-ready app changes without conversation-friction input.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();
    await session.send(`Supported repository at ${repository}
Product brief: Build an internal vendor-onboarding workflow for operations to review new vendor submissions, resolve missing information, and involve Finance when tax verification is actually required.`);
    session.requireInputRequest({ toolName: "apply_app_creation" });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.toolOrder([
      "inspect_source",
      "prepare_workspace",
      "record_prototype_artifact",
      "accept_app_spec",
      "record_prototype_artifact",
      "accept_app_spec",
      "apply_app_creation",
      "validate_app_creation",
      "change_set_status",
      "accept_change_set",
    ]);
    t.calledTool("inspect_source", { count: 1 });
    t.calledTool("prepare_workspace", { count: 1 });
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: {
        content: (value) => {
          const parsedValue = stringInputSchema.safeParse(value);
          return (
            parsedValue.success &&
            parsedValue.data.includes("Operations review queue") &&
            parsedValue.data.includes("Finance: verify tax information") &&
            parsedValue.data.includes('id="detail-title"')
          );
        },
        mediaType: "text/html",
        path: "prototype/vendor-onboarding/index.html",
      },
    });
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: { path: "prototype/vendor-onboarding/decisions.md" },
    });
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: {
        content: (value) => {
          const parsedValue = stringInputSchema.safeParse(value);
          return parsedValue.success && !parsedValue.data.includes("## Build handoff");
        },
        path: "prototype/vendor-onboarding/app-spec.md",
      },
    });
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: {
        content: (value) => {
          const parsedValue = stringInputSchema.safeParse(value);
          return (
            parsedValue.success &&
            parsedValue.data.includes("## Build handoff") &&
            parsedValue.data.includes('"status": "build-ready"')
          );
        },
        path: "prototype/vendor-onboarding/app-spec.md",
      },
    });
    t.calledTool("accept_app_spec", { count: 1, status: "failed" });
    t.calledTool("accept_app_spec", { count: 1 });
    t.notCalledTool("prepare_target_dependencies");
    t.calledTool("apply_app_creation", { count: 1 });
    t.calledTool("validate_app_creation", { count: 1 });
    t.calledTool("change_set_status", { count: 1 });
    t.calledTool("accept_change_set", { count: 1 });
    t.notCalledTool("publish_reviewed_change_set");
    t.notCalledTool("publish_reviewed_change_set_to_branch_worktree");
    t.notCalledTool("publish_github_draft_pr");
    t.notCalledTool("agent");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(turn1.message, includes("Vendor Onboarding"));
    t.check(turn1.message, includes("`vendor-onboarding`"));
    t.check(turn1.message, includes("operations review queue"));
    t.check(turn1.message, includes("vendor detail panel"));
    t.check(turn1.message, includes("conditional Finance verification step"));
    t.check(turn1.message, includes("implementation plan and complete app changes"));
    t.check(turn1.message, includes("ready to review"));
    t.check(turn1.message, includes("draft pull request"));
    t.check(
      turn1.message,
      satisfies(
        (reply) =>
          isProductFacing(String(reply)) &&
          !/(?:no mutation|nothing was (?:created|written)|[0-9a-f]{40})/iu.test(String(reply)) &&
          !/\b(?:queue|form|dashboard)\?/iu.test(String(reply)),
        "assistant reply stays product-facing and does not ask identity or interface-selection questions",
      ),
    );
    session.eventsSatisfy(
      "all public assistant messages omit routine source and authority mechanics",
      (events) => {
        const messages = events.flatMap((event) => {
          const candidate = completedMessageEventSchema.safeParse(event);
          return candidate.success ? [candidate.data.data.message] : [];
        });
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
