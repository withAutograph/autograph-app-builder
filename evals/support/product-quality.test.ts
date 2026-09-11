import { describe, expect, it } from "vitest";

import {
  evaluateConversationQuality,
  evaluatePrototypeQuality,
  productQualityScenario,
  PRODUCT_QUALITY_SCENARIOS,
} from "./product-quality";

const completeAppSpec = `## Status and prototype

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
  "schema": { "kind": "none" },
  "additionalPublicRoutes": [],
  "optionalCapabilities": {
    "integrations": [],
    "hostedResources": []
  }
}
\`\`\``;

const completePrototype = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"></head><body><main><section aria-labelledby="detail-title"><h1 id="detail-title">Northstar Logistics</h1><p>Operations review queue</p><p>Finance: verify tax information</p></section></main></body></html>`;

describe("product-quality scenarios", () => {
  it("defines the four supported product flows", () => {
    expect(PRODUCT_QUALITY_SCENARIOS.map(({ id }) => id)).toEqual([
      "vendor-onboarding",
      "material-product-ambiguity",
      "explicit-preference",
      "unavailable-product-alternative",
    ]);
  });

  it("fails a needless question in a sparse workflow", () => {
    const report = evaluateConversationQuality({
      reply:
        "Vendor Onboarding has an operations review queue, vendor detail panel, and conditional Finance verification step. Which layout should I use?",
      scenario: productQualityScenario("vendor-onboarding"),
    });
    expect(report.hardFailures).toContain(
      "Conversation asked an unnecessary product question."
    );
  });

  it("accepts one recommended question for material ambiguity", () => {
    const report = evaluateConversationQuality({
      reply:
        "These are meaningfully different products. Should the first version focus on initial onboarding (recommended) or continuously monitoring vendors?",
      scenario: productQualityScenario("material-product-ambiguity"),
    });
    expect(report.hardFailures).toEqual([]);
  });

  it("validates the complete prototype and AppSpec together", () => {
    const scenario = productQualityScenario("vendor-onboarding");
    const report = evaluatePrototypeQuality({
      appSpec: completeAppSpec,
      html: completePrototype,
      scenario,
    });
    expect(report.hardFailures).toEqual([]);
  });

  it("rejects an incomplete or inaccessible prototype", () => {
    const scenario = productQualityScenario("vendor-onboarding");
    const report = evaluatePrototypeQuality({
      appSpec: "## Build handoff\n\n{}",
      html: "<html><body>lorem ipsum</body></html>",
      scenario,
    });
    expect(report.hardFailures).toContain("Prototype lacks a language.");
    expect(report.hardFailures).toContain("Prototype lacks a main landmark.");
    expect(report.hardFailures).toContain(
      "Prototype contains unfinished placeholder content."
    );
  });
});
