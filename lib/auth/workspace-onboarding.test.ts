import { describe, expect, it, vi } from "vitest";

import { OrganizationProvisioningError } from "./preview-user-management";
import {
  logWorkspaceOnboardingFailure,
  resolveWorkspaceOnboardingState,
  signInForWorkspaceRedirect,
  workspaceOnboardingRedirect,
} from "./workspace-onboarding";

describe("workspace onboarding", () => {
  it("logs only the allowlisted failure category and stage for an unexpected error", async () => {
    const error = new Error("private email and token details");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        resolveWorkspaceOnboardingState(async () => {
          throw error;
        }),
      ).resolves.toEqual({ status: "workspace-setup-retry" });
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).toBe(
        JSON.stringify({
          category: "unexpected",
          event: "preview_workspace_reconciliation_failed",
          stage: "unknown",
        }),
      );
      expect(String(log.mock.calls[0]?.[0])).not.toContain("private email");
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["access-revoked", "access-revoked", "access-denied"],
    ["workspace-ambiguous", "ambiguous", "workspace-ambiguous"],
    ["verified-identity-required", "identity-required", "access-denied"],
    ["signup-disabled", "signup-disabled", "access-denied"],
    ["workspace-setup-failed", "workspace-setup-failed", "workspace-setup-retry"],
  ] as const)(
    "logs the finite %s category without exception text",
    async (reason, category, status) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          resolveWorkspaceOnboardingState(async () => {
            throw new OrganizationProvisioningError(reason, {
              cause: new Error("private persistence detail"),
            });
          }),
        ).resolves.toEqual({ status });
        expect(log).toHaveBeenCalledWith(
          JSON.stringify({
            category,
            event: "preview_workspace_reconciliation_failed",
            stage: "unknown",
          }),
        );
        expect(String(log.mock.calls[0]?.[0])).not.toContain("private persistence detail");
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each([
    "runtime-initialization",
    "session-lookup",
    "workspace-provisioning",
    "organization-activation",
  ] as const)("logs the explicit %s stage", (stage) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logWorkspaceOnboardingFailure(new Error("secret-bearing exception"), stage);
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          category: "unexpected",
          event: "preview_workspace_reconciliation_failed",
          stage,
        }),
      );
      expect(String(log.mock.calls[0]?.[0])).not.toContain("secret-bearing");
    } finally {
      log.mockRestore();
    }
  });

  it("uses safe unexpected fallback for an unknown provisioning reason", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        // Simulate a stale or cross-version reason without expanding the production type.
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        resolveWorkspaceOnboardingState(async () => {
          throw Object.assign(new OrganizationProvisioningError("workspace-setup-failed"), {
            reason: "unknown-private-reason",
          });
        }),
      ).resolves.toEqual({ status: "workspace-setup-retry" });
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          category: "unexpected",
          event: "preview_workspace_reconciliation_failed",
          stage: "unknown",
        }),
      );
      expect(String(log.mock.calls[0]?.[0])).not.toContain("unknown-private-reason");
    } finally {
      log.mockRestore();
    }
  });

  it("keeps onboarding recovery intact if diagnostic logging throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("logging failure");
    });
    try {
      await expect(
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        resolveWorkspaceOnboardingState(async () => {
          throw new Error("original failure");
        }),
      ).resolves.toEqual({ status: "workspace-setup-retry" });
    } finally {
      log.mockRestore();
    }
  });

  it("maps a non-Error rejection to a safe unexpected category", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        resolveWorkspaceOnboardingState(async () => {
          // oxlint-disable-next-line eslint/no-throw-literal, typescript/only-throw-error -- Exercise arbitrary JavaScript rejection payloads without exposing them.
          throw { token: "secret-value" };
        }),
      ).resolves.toEqual({ status: "workspace-setup-retry" });
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          category: "unexpected",
          event: "preview_workspace_reconciliation_failed",
          stage: "unknown",
        }),
      );
      expect(String(log.mock.calls[0]?.[0])).not.toContain("secret-value");
    } finally {
      log.mockRestore();
    }
  });

  it("allows the signed-in product only after workspace setup succeeds", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const value = { userId: "user_one", workspaceId: "workspace_one" };
    try {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      await expect(resolveWorkspaceOnboardingState(async () => value)).resolves.toEqual({
        status: "ready",
        value,
      });
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      await expect(resolveWorkspaceOnboardingState(async () => {})).resolves.toEqual({
        status: "anonymous",
      });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["workspace-setup-failed", "workspace-setup-retry"],
    ["workspace-ambiguous", "workspace-ambiguous"],
    ["access-revoked", "access-denied"],
    ["verified-identity-required", "access-denied"],
    ["signup-disabled", "access-denied"],
  ] as const)("maps %s to %s", async (reason, status) => {
    await expect(
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      resolveWorkspaceOnboardingState(async () => {
        throw new OrganizationProvisioningError(reason);
      }),
    ).resolves.toEqual({ status });
  });

  it("uses one shared onboarding recovery surface", () => {
    expect(workspaceOnboardingRedirect("https://builder.example", "workspace-setup-retry")).toBe(
      "https://builder.example/?onboarding=workspace-setup-retry",
    );
    expect(signInForWorkspaceRedirect("https://builder.example")).toBe(
      "https://builder.example/auth/sign-in?callbackURL=%2F",
    );
  });
});
