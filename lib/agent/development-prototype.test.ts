import { describe, expect, it } from "vitest";

import { validateBuildReadyAppSpec } from "./app-spec-validation";
import { developmentPrototypeBundle } from "./development-prototype";

describe("development prototype bundle", () => {
  it("expands a concise product brief into a small usable bundle", () => {
    const bundle = developmentPrototypeBundle({
      appId: "stock-exceptions",
      productName: "Stock Exceptions",
      brief: "Help operations analysts resolve stock exceptions.",
    });
    expect(bundle.indexHtml).toContain("Stock Exceptions");
    expect(bundle.indexHtml).toContain("review queue");
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
});
