import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AuthLoadingShell,
  HandoffLoadingShell,
  ProviderConnectionLoadingShell,
} from "./route-loading-shell";

describe("route loading shells", () => {
  it("keeps authentication routes identifiable before request data streams", () => {
    const html = renderToStaticMarkup(
      <AuthLoadingShell title="Sign in to Autograph" />,
    );

    expect(html).toContain("Sign in to Autograph");
    expect(html).toContain("Preparing secure sign-in");
    expect(html).toContain("Authentication form loading");
  });

  it("keeps provider connection routes actionable before search params stream", () => {
    const html = renderToStaticMarkup(
      <ProviderConnectionLoadingShell
        title="Connect a GitHub App installation"
        description="Choose repository access."
      />,
    );

    expect(html).toContain("Connect a GitHub App installation");
    expect(html).toContain("Choose repository access.");
    expect(html).toContain("Provider connection loading");
  });

  it("keeps a handoff route identifiable before its saved journal streams", () => {
    const html = renderToStaticMarkup(<HandoffLoadingShell />);

    expect(html).toContain("Continue your app");
    expect(html).toContain("Loading your saved handoff");
    expect(html).toContain("Handoff loading");
  });
});
