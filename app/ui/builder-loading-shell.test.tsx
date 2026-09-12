import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuilderLoadingShell } from "./builder-loading-shell";

describe("BuilderLoadingShell", () => {
  it("renders field labels without creating duplicate form controls", () => {
    const html = renderToStaticMarkup(<BuilderLoadingShell />);

    expect(html).toContain("Create an app");
    expect(html).toContain("App Name");
    expect(html).toContain("What should this app do?");
    expect(html).toContain("Where should we prepare it?");
    expect(html).toContain('aria-label="Builder form loading"');
    expect(html).not.toMatch(/<(?:input|textarea|select|label)\b/);
  });
});
