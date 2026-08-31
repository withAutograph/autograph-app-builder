import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EmulationApproval,
  emulationApprovalStyles,
} from "./emulation-approval";

describe("EmulationApproval", () => {
  it.each([
    {
      provider: "github" as const,
      environment: "Local development" as const,
      account: "Autograph Developer",
      handle: "@autograph-dev",
      detail: { label: "Repository", value: "autograph-local/demo-app" },
      label: "Connect emulated GitHub",
    },
    {
      provider: "vercel" as const,
      environment: "Preview deployment" as const,
      account: "Autograph Developer",
      handle: "autograph-dev",
      detail: { label: "Team", value: "Autograph Local" },
      label: "Connect emulated Vercel",
    },
  ])("renders the $provider approval with its exact seeded scope", (input) => {
    const html = renderToStaticMarkup(
      <EmulationApproval
        provider={input.provider}
        environment={input.environment}
        title={input.label}
        description="Approve the seeded identity."
        account={input.account}
        handle={input.handle}
        details={[input.detail]}
        scope="Access is limited to the seeded scope."
        actionLabel={input.label}
        action={
          <button className={emulationApprovalStyles.button} type="submit">
            {input.label}
          </button>
        }
      />,
    );

    expect(html).toContain(input.label);
    expect(html).toContain(input.account);
    expect(html).toContain(input.handle);
    expect(html).toContain(input.detail.label);
    expect(html).toContain(input.detail.value);
    expect(html).toContain(`${input.environment} only · Powered by Emulate`);
    expect(html).toContain('href="/"');
    expect(html).not.toContain("auth-shell");
  });
});
