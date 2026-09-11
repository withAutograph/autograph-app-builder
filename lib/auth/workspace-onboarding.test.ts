import { describe, expect, it } from "vitest";

import { OrganizationProvisioningError } from "./preview-user-management";
import {
  resolveWorkspaceOnboardingState,
  signInForWorkspaceRedirect,
  workspaceOnboardingRedirect,
} from "./workspace-onboarding";

describe("workspace onboarding", () => {
  it("allows the signed-in product only after workspace setup succeeds", async () => {
    const value = { userId: "user_one", workspaceId: "workspace_one" };
    await expect(
      resolveWorkspaceOnboardingState(async () => value),
    ).resolves.toEqual({ status: "ready", value });
    await expect(
      resolveWorkspaceOnboardingState(async () => undefined),
    ).resolves.toEqual({ status: "anonymous" });
  });

  it.each([
    ["workspace-setup-failed", "workspace-setup-retry"],
    ["workspace-ambiguous", "workspace-ambiguous"],
    ["access-revoked", "access-denied"],
    ["verified-identity-required", "access-denied"],
    ["signup-disabled", "access-denied"],
  ] as const)("maps %s to %s", async (reason, status) => {
    await expect(
      resolveWorkspaceOnboardingState(async () => {
        throw new OrganizationProvisioningError(reason);
      }),
    ).resolves.toEqual({ status });
  });

  it("uses one shared onboarding recovery surface", () => {
    expect(
      workspaceOnboardingRedirect(
        "https://builder.example",
        "workspace-setup-retry",
      ),
    ).toBe("https://builder.example/?onboarding=workspace-setup-retry");
    expect(signInForWorkspaceRedirect("https://builder.example")).toBe(
      "https://builder.example/auth/sign-in?callbackURL=%2F",
    );
  });
});
