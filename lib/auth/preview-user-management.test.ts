import { describe, expect, it, vi } from "vitest";

import {
  createPreviewUserManagementLifecycle,
  type PreviewOrganizationUserAuthority,
} from "./preview-user-management";

function createAuthority(input?: {
  pendingOrganizationId?: string;
  activeOrganizationId?: string;
}) {
  const authority: PreviewOrganizationUserAuthority = {
    pendingOrganizationForVerifiedEmail: vi.fn(async () =>
      Promise.resolve(input?.pendingOrganizationId),
    ),
    activatePendingInvitation: vi.fn(async () =>
      Promise.resolve(input?.pendingOrganizationId ?? "workspace_one"),
    ),
    activeOrganizationForUser: vi.fn(async () =>
      Promise.resolve(input?.activeOrganizationId),
    ),
  };
  return authority;
}

const invitedUser = {
  id: "user_one",
  email: "Invited@Example.com",
  emailVerified: true,
};

describe("Preview Better Auth user management", () => {
  it("admits an invited verified GitHub user and activates the invitation", async () => {
    const authority = createAuthority({
      pendingOrganizationId: "workspace_one",
      activeOrganizationId: "workspace_one",
    });
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeUserCreate(invitedUser, { path: "/callback/github" }),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.afterUserCreate(invitedUser, { path: "/callback/github" }),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.beforeSessionCreate({
        userId: invitedUser.id,
        token: "session-token",
      }),
    ).resolves.toEqual({
      data: {
        activeOrganizationId: "workspace_one",
        token: "session-token",
        userId: invitedUser.id,
      },
    });

    expect(authority.pendingOrganizationForVerifiedEmail).toHaveBeenCalledWith({
      email: "invited@example.com",
    });
    expect(authority.activatePendingInvitation).toHaveBeenCalledWith({
      email: "invited@example.com",
      userId: invitedUser.id,
    });
  });

  it("admits an invited verified Vercel user and activates the invitation", async () => {
    const authority = createAuthority({
      pendingOrganizationId: "workspace_one",
      activeOrganizationId: "workspace_one",
    });
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeUserCreate(invitedUser, { path: "/callback/vercel" }),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.afterUserCreate(invitedUser, { path: "/callback/vercel" }),
    ).resolves.toBeUndefined();
    expect(authority.activatePendingInvitation).toHaveBeenCalledWith({
      email: "invited@example.com",
      userId: invitedUser.id,
    });
  });

  it("rejects an uninvited GitHub user before activation", async () => {
    const authority = createAuthority();
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeUserCreate(invitedUser, { path: "/callback/github" }),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "AUTOGRAPH_INVITATION_REQUIRED" },
    });
    expect(authority.activatePendingInvitation).not.toHaveBeenCalled();
  });

  it("rejects an unverified GitHub email without querying invitations", async () => {
    const authority = createAuthority({
      pendingOrganizationId: "workspace_one",
    });
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeUserCreate(
        { ...invitedUser, emailVerified: false },
        { path: "/callback/github" },
      ),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "AUTOGRAPH_INVITATION_REQUIRED" },
    });
    expect(
      authority.pendingOrganizationForVerifiedEmail,
    ).not.toHaveBeenCalled();
  });

  it("leaves non-GitHub administrative user creation to the admin plugin", async () => {
    const authority = createAuthority();
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await expect(
      lifecycle.beforeUserCreate(invitedUser, { path: "/admin/create-user" }),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.afterUserCreate(invitedUser, { path: "/admin/create-user" }),
    ).resolves.toBeUndefined();
    expect(
      authority.pendingOrganizationForVerifiedEmail,
    ).not.toHaveBeenCalled();
    expect(authority.activatePendingInvitation).not.toHaveBeenCalled();
  });

  it.each(["zero", "multiple"])(
    "fails a %s-active-organization session with a product-facing access error",
    async () => {
      const authority = createAuthority();
      const lifecycle = createPreviewUserManagementLifecycle(authority);

      await expect(
        lifecycle.beforeSessionCreate({ userId: invitedUser.id }),
      ).rejects.toMatchObject({
        status: "FORBIDDEN",
        body: { code: "AUTOGRAPH_WORKSPACE_UNAVAILABLE" },
      });
    },
  );

  it("supports an idempotent callback retry through the authority boundary", async () => {
    const authority = createAuthority({
      pendingOrganizationId: "workspace_one",
      activeOrganizationId: "workspace_one",
    });
    const lifecycle = createPreviewUserManagementLifecycle(authority);

    await lifecycle.beforeUserCreate(invitedUser, { path: "/callback/github" });
    await lifecycle.afterUserCreate(invitedUser, { path: "/callback/github" });
    await lifecycle.afterUserCreate(invitedUser, { path: "/callback/github" });

    expect(authority.activatePendingInvitation).toHaveBeenCalledTimes(2);
    await expect(
      lifecycle.beforeSessionCreate({ userId: invitedUser.id }),
    ).resolves.toMatchObject({
      data: { activeOrganizationId: "workspace_one" },
    });
  });
});
