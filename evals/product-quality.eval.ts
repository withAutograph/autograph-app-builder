import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { validateBuildReadyAppSpec } from "../lib/agent/app-spec-validation";
import {
  evaluateConversationQuality,
  evaluatePrototypeQuality,
  productQualityScenario,
} from "./support/product-quality";
import { isProductFacing } from "./support/public-conversation";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function assertQuality(report: { hardFailures: readonly string[] }, label: string) {
  return satisfies(
    () => report.hardFailures.length === 0,
    `${label}: ${report.hardFailures.join(" ") || "passed"}`,
  );
}

export default defineEval({
  description:
    "Curated product briefs prove that App Builder keeps a productive public conversation, records a usable prototype and contract, and preserves explicit product preferences.",
  tags: ["product-quality"],
  async test(t) {
    const session = await t.session();
    const vendor = productQualityScenario("vendor-onboarding");
    const repository = createSupportedRepositoryFixture();
    await session.send(`Supported repository at ${repository}\nProduct brief: ${vendor.brief}`);
    session.requireInputRequest({ toolName: "apply_app_creation" });
    const turn1 = await session.respondAll("approve");
    t.succeeded();
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: {
        content: (value) => {
          if (typeof value !== "string") {
            return false;
          }
          const report = evaluatePrototypeQuality({
            appSpec: `## Status and prototype

prototype/vendor-onboarding/index.html

## User and outcome

Confirmed.

## Interfaces and navigation

Confirmed.

## Controls and behavior

Confirmed.

## Data model

Confirmed.

## Integrations and reconciliation

Deferred.

## Temporal semantics

Deferred.

## Writes, review, and authority

Confirmed.

## Access and tenancy

Confirmed.

## Agent behavior

Confirmed.

## Operational states

Confirmed.

## Defaults, non-goals, and risks

Confirmed.

## Acceptance walkthrough

Confirmed.

## Build handoff

\`\`\`json
{
  "status": "build-ready"
}
\`\`\``,
            html: value,
            scenario: vendor,
          });
          return report.hardFailures.length === 0;
        },
        path: "prototype/vendor-onboarding/index.html",
      },
    });
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: {
        content: (value) =>
          typeof value === "string" &&
          value.includes("Operations starts from a review queue") &&
          value.includes("Finance tax verification appears only"),
        path: "prototype/vendor-onboarding/decisions.md",
      },
    });
    t.calledTool("record_prototype_artifact", {
      count: 1,
      input: {
        content: (value) =>
          typeof value === "string" &&
          validateBuildReadyAppSpec(value).valid &&
          value.includes("prototype/vendor-onboarding/index.html"),
        path: "prototype/vendor-onboarding/app-spec.md",
      },
    });
    t.calledTool("apply_app_creation", { count: 1 });
    t.calledTool("validate_app_creation", { count: 1 });
    t.check(
      turn1.message,
      assertQuality(
        evaluateConversationQuality({
          reply: String(turn1.message),
          scenario: vendor,
        }),
        vendor.id,
      ),
    );

    const ambiguity = productQualityScenario("material-product-ambiguity");
    const turn2 = await session.send(`Uncertain vendor workflow brief: ${ambiguity.brief}`);
    t.check(
      turn2.message,
      assertQuality(
        evaluateConversationQuality({
          reply: String(turn2.message),
          scenario: ambiguity,
        }),
        ambiguity.id,
      ),
    );

    const preference = productQualityScenario("explicit-preference");
    const turn3 = await session.send(`Explicit vendor workflow preferences: ${preference.brief}`);
    t.check(
      turn3.message,
      assertQuality(
        evaluateConversationQuality({
          reply: String(turn3.message),
          scenario: preference,
        }),
        preference.id,
      ),
    );

    const unavailable = productQualityScenario("unavailable-product-alternative");
    const turn4 = await session.send(unavailable.brief);
    t.check(
      turn4.message,
      assertQuality(
        evaluateConversationQuality({
          reply: String(turn4.message),
          scenario: unavailable,
        }),
        unavailable.id,
      ),
    );
    session.eventsSatisfy(
      "all assistant messages stay product-facing across the quality suite",
      (events) => {
        const messages = events.flatMap((event) => {
          const candidate = event as {
            type?: unknown;
            data?: { message?: unknown };
          };
          return candidate.type === "message.completed" &&
            typeof candidate.data?.message === "string"
            ? [candidate.data.message]
            : [];
        });
        return messages.length <= 4 && messages.every(isProductFacing);
      },
    );
  },
});
