import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ConsentLoading from "../(product)/auth/consent/loading";
import SignOutLoading from "../(product)/auth/sign-out/loading";
import AccountLoading from "../(product)/settings/account/loading";

import {
  AuthLoadingShell,
  HandoffLoadingShell,
  ProviderConnectionLoadingShell,
} from "./route-loading-shell";

describe("route loading shells", () => {
  it.each([
    [ConsentLoading, "Authorize access", "Loading the requested permissions"],
    [SignOutLoading, "Signing out of Autograph", "Preparing secure sign-out"],
    [AccountLoading, "Account settings", "Loading your profile and security settings"],
  ] as const)("renders a request-free destination shell for %s", (Loading, title, status) => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain(title);
    expect(html).toContain(status);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Preparing secure sign-in");
  });

  it("keeps authentication routes identifiable before request data streams", () => {
    const html = renderToStaticMarkup(<AuthLoadingShell title="Sign in to Autograph" />);

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
