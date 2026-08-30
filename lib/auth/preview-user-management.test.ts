import { DatabaseSync } from "node:sqlite";

import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";

import {
  createPreviewUserManagementLifecycle,
  OrganizationProvisioningError,
  previewUserManagementPlugins,
  type OrganizationProvisioningFailure,
  type PreviewOrganizationUserAuthority,
} from "./preview-user-management";

function createAuthority(input?: {
  failure?: OrganizationProvisioningFailure;
}) {
  const authority: PreviewOrganizationUserAuthority = {
    ensureOrganizationForVerifiedUser: vi.fn(async () => {
      if (input?.failure) {
        throw new OrganizationProvisioningError(input.failure);
      }
      return {
        organizationId: "organization_one",
        workspaceId: "workspace_one",
      };
    }),
  };
  return authority;
}

const verifiedUser = {
  id: "user_one",
  email: "Person@Example.com",
  emailVerified: true,
};

describe("Preview Better Auth user management", () => {
  it.each(["/callback/github", "/callback/vercel"])(
    "admits a verified provider callback at %s and normalizes its email",
    async (path) => {
      const lifecycle = createPreviewUserManagementLifecycle(createAuthority());

      await expect(
        lifecycle.beforeUserCreate(verifiedUser, { path }),
      ).resolves.toMatchObject({
        data: { email: "person@example.com", emailVerified: true },
      });
    },
  );

  it("rejects an unverified provider identity before user creation", async () => {
    const authority = createAuthority();
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeUserCreate(
        { ...verifiedUser, emailVerified: false },
        { path: "/callback/github" },
      ),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "AUTOGRAPH_VERIFIED_IDENTITY_REQUIRED" },
    });
    expect(authority.ensureOrganizationForVerifiedUser).not.toHaveBeenCalled();
  });

  it("leaves administrative user creation to the admin plugin", async () => {
    const lifecycle = createPreviewUserManagementLifecycle(createAuthority());
    await expect(
      lifecycle.beforeUserCreate(verifiedUser, { path: "/admin/create-user" }),
    ).resolves.toBeUndefined();
  });

  it("ensures one workspace before persisting every session", async () => {
    const authority = createAuthority();
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeSessionCreate({
        userId: verifiedUser.id,
        token: "session-token",
      }),
    ).resolves.toEqual({
      data: {
        activeOrganizationId: "organization_one",
        token: "session-token",
        userId: verifiedUser.id,
      },
    });
    expect(authority.ensureOrganizationForVerifiedUser).toHaveBeenCalledWith({
      userId: verifiedUser.id,
    });
  });

  it("defers first passkey workspace reconciliation until registration commits", async () => {
    const authority = createAuthority();
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeSessionCreate(
        { userId: verifiedUser.id },
        { path: "/passkey/verify-registration" },
      ),
    ).resolves.toBeUndefined();
    expect(authority.ensureOrganizationForVerifiedUser).not.toHaveBeenCalled();
  });

  it("registers workspace provisioning on Better Auth session creation", async () => {
    const authority = createAuthority();
    const database = new DatabaseSync(":memory:");
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "better-auth-secret-that-is-long-enough-for-testing",
      database,
      emailAndPassword: { enabled: true },
      plugins: [...previewUserManagementPlugins(authority)],
    });
    await (await auth.$context).runMigrations();

    await auth.api.signUpEmail({
      body: {
        email: "person@example.com",
        name: "Person",
        password: "test-password-123",
      },
    });

    expect(authority.ensureOrganizationForVerifiedUser).toHaveBeenCalledOnce();
    expect(
      database.prepare('select "activeOrganizationId" from "session"').get(),
    ).toEqual({ activeOrganizationId: "organization_one" });
  });

  it.each([
    ["access-revoked", "AUTOGRAPH_WORKSPACE_ACCESS_REVOKED", "FORBIDDEN"],
    ["signup-disabled", "AUTOGRAPH_SIGNUP_UNAVAILABLE", "FORBIDDEN"],
    [
      "verified-identity-required",
      "AUTOGRAPH_VERIFIED_IDENTITY_REQUIRED",
      "FORBIDDEN",
    ],
    ["workspace-ambiguous", "AUTOGRAPH_WORKSPACE_AMBIGUOUS", "CONFLICT"],
    [
      "workspace-setup-failed",
      "AUTOGRAPH_WORKSPACE_SETUP_FAILED",
      "SERVICE_UNAVAILABLE",
    ],
  ] as const)(
    "maps %s to the product-facing %s error",
    async (failure, code, status) => {
      const lifecycle = createPreviewUserManagementLifecycle(
        createAuthority({ failure }),
      );
      await expect(
        lifecycle.beforeSessionCreate({ userId: verifiedUser.id }),
      ).rejects.toMatchObject({ status, body: { code } });
    },
  );

  it("masks unexpected persistence failures and remains retry-safe", async () => {
    const authority: PreviewOrganizationUserAuthority = {
      ensureOrganizationForVerifiedUser: vi
        .fn()
        .mockRejectedValueOnce(new Error("database detail"))
        .mockResolvedValueOnce({
          organizationId: "organization_one",
          workspaceId: "workspace_one",
        }),
    };
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeSessionCreate({ userId: verifiedUser.id }),
    ).rejects.toMatchObject({
      body: { code: "AUTOGRAPH_WORKSPACE_SETUP_FAILED" },
    });
    await expect(
      lifecycle.beforeSessionCreate({ userId: verifiedUser.id }),
    ).resolves.toMatchObject({
      data: { activeOrganizationId: "organization_one" },
    });
  });
});
