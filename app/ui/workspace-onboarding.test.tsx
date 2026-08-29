import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceOnboarding } from "./workspace-onboarding";

describe("WorkspaceOnboarding", () => {
  it.each([
    ["workspace-setup-retry", "We couldn’t finish setting up your workspace"],
    ["workspace-ambiguous", "Choose your Autograph workspace"],
    ["access-denied", "Your workspace isn’t available"],
  ] as const)("renders the %s product state", (status, heading) => {
    const html = renderToStaticMarkup(<WorkspaceOnboarding status={status} />);
    expect(html).toContain(heading);
    expect(html).toContain('href="/auth/sign-out"');
    expect(html).not.toContain("active App Builder workspace");
    expect(html).not.toContain("Ask an administrator");
    expect(html).not.toContain("workspace-unavailable");
  });
});
