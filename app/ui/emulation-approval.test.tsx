import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EmulationApproval,
  emulationApprovalStyles,
} from "./emulation-approval";

describe("EmulationApproval", () => {
  it.each([
    {
      account: "Autograph Developer",
      detail: { label: "Repository", value: "autograph-local/demo-app" },
      environment: "Local development" as const,
      handle: "@autograph-dev",
      label: "Connect emulated GitHub",
      provider: "github" as const,
    },
    {
      account: "Autograph Developer",
      detail: { label: "Team", value: "Autograph Local" },
      environment: "Preview deployment" as const,
      handle: "autograph-dev",
      label: "Connect emulated Vercel",
      provider: "vercel" as const,
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
      />
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
