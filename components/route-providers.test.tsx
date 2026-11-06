import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteProviders } from "./route-providers";

describe("route-local auth configuration", () => {
  it("keeps request-fresh auth configuration below the route shell", () => {
    const fallback = <h1>Create your Autograph account</h1>;
    const children = <p>Authenticated route content</p>;
    expect(
      renderToStaticMarkup(<RouteProviders fallback={fallback}>{children}</RouteProviders>),
    ).toContain("Authenticated route content");
  });
});
