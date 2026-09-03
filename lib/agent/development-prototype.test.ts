import { describe, expect, it } from "vitest";

import { validateBuildReadyAppSpec } from "./app-spec-validation";
import { developmentPrototypeBundle } from "./development-prototype";

describe("development prototype bundle", () => {
  it("expands a concise product brief into a small usable bundle", () => {
    const bundle = developmentPrototypeBundle({
      appId: "stock-exceptions",
      productName: "Stock Exceptions",
      brief: "Help operations analysts resolve stock exceptions.",
      product: {
        outcome: "Investigate stock exceptions before they delay fulfillment.",
        itemLabels: ["Low inventory: A-104", "Transfer delayed: B-210"],
        filters: ["My queue", "Critical"],
        keyFacts: [
          { label: "Warehouse", value: "Austin" },
          { label: "Impact", value: "12 orders" },
        ],
        primaryAction: "Assign resolution",
        states: ["Critical", "Investigating", "Resolved"],
      },
    });
    expect(bundle.indexHtml).toContain("Stock Exceptions");
    expect(bundle.indexHtml).toContain("review queue");
    expect(bundle.indexHtml).toContain("Low inventory: A-104");
    expect(bundle.indexHtml).toContain("Austin");
    expect(bundle.indexHtml).toContain("Assign resolution");
    expect(bundle.indexHtml.length).toBeLessThan(8_000);
    expect(bundle.decisionsMarkdown).toContain("Help operations analysts");
    expect(validateBuildReadyAppSpec(bundle.appSpecMarkdown)).toEqual({
      valid: true,
    });
  });

  it("keeps user-supplied text inert in the Browser prototype", () => {
    const bundle = developmentPrototypeBundle({
      appId: "safe-brief",
      brief: '<img src=x onerror="alert(1)">',
    });
    expect(bundle.indexHtml).toContain("&lt;img");
    expect(bundle.indexHtml).not.toContain("<img src=x");
  });

  it("gives the primary action an accessible, usable interaction", () => {
    const bundle = developmentPrototypeBundle({
      appId: "vendor-onboarding",
      brief: "Review new vendors.",
      product: { primaryAction: "Add vendor" },
    });
    expect(bundle.indexHtml).toContain('id="primary-action"');
    expect(bundle.indexHtml).toContain('<dialog class="dialog"');
    expect(bundle.indexHtml).toContain('aria-live="polite"');
    expect(bundle.indexHtml).toContain('name="note" required');
    expect(bundle.indexHtml).toContain('id="action-cancel"');
    expect(bundle.indexHtml).toContain(
      ";document.querySelector('#action-cancel')",
    );
    expect(bundle.indexHtml).toContain("Saved: ");
  });
});
