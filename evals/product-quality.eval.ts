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

function assertQuality(
  report: { hardFailures: readonly string[] },
  label: string,
) {
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
    const vendor = productQualityScenario("vendor-onboarding");
    const repository = createSupportedRepositoryFixture();
    await t.send(
      `Supported repository at ${repository}\nProduct brief: ${vendor.brief}`,
    );
    t.succeeded();
    t.calledTool("record_prototype_artifact", {
      input: {
        path: "prototype/vendor-onboarding/index.html",
        content: (value) => {
          if (typeof value !== "string") return false;
          const report = evaluatePrototypeQuality({
            scenario: vendor,
            html: value,
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
  "status": "build-ready",
  "owner": "operations",
  "schema": { "kind": "kernel" },
  "additionalPublicRoutes": [],
  "optionalCapabilities": { "integrations": [], "hostedResources": [] }
}
\`\`\``,
          });
          return report.hardFailures.length === 0;
        },
      },
      count: 1,
    });
    t.calledTool("record_prototype_artifact", {
      input: {
        path: "prototype/vendor-onboarding/decisions.md",
        content: (value) =>
          typeof value === "string" &&
          value.includes("Operations starts from a review queue") &&
          value.includes("Finance tax verification appears only"),
      },
      count: 1,
    });
    t.calledTool("record_prototype_artifact", {
      input: {
        path: "prototype/vendor-onboarding/app-spec.md",
        content: (value) =>
          typeof value === "string" &&
          validateBuildReadyAppSpec(value).valid &&
          value.includes("prototype/vendor-onboarding/index.html"),
      },
      count: 1,
    });
    t.calledTool("apply_app_creation", { count: 1 });
    t.calledTool("validate_app_creation", { count: 1 });
    t.check(
      t.reply,
      assertQuality(
        evaluateConversationQuality({
          scenario: vendor,
          reply: String(t.reply),
        }),
        vendor.id,
      ),
    );

    const ambiguity = productQualityScenario("material-product-ambiguity");
    await t.send(`Uncertain vendor workflow brief: ${ambiguity.brief}`);
    t.check(
      t.reply,
      assertQuality(
        evaluateConversationQuality({
          scenario: ambiguity,
          reply: String(t.reply),
        }),
        ambiguity.id,
      ),
    );

    const preference = productQualityScenario("explicit-preference");
    await t.send(`Explicit vendor workflow preferences: ${preference.brief}`);
    t.check(
      t.reply,
      assertQuality(
        evaluateConversationQuality({
          scenario: preference,
          reply: String(t.reply),
        }),
        preference.id,
      ),
    );

    const unavailable = productQualityScenario(
      "unavailable-product-alternative",
    );
    await t.send(unavailable.brief);
    t.check(
      t.reply,
      assertQuality(
        evaluateConversationQuality({
          scenario: unavailable,
          reply: String(t.reply),
        }),
        unavailable.id,
      ),
    );
    t.eventsSatisfy(
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
