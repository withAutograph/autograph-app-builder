import { describe, expect, it, vi } from "vitest";

import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";

const binding = {
  issuer: "https://preview.example.test/api/auth",
  audience: "https://preview.example.test/mcp",
};

function createDatabase(results: unknown[]) {
  const execute = vi.fn(async () => {
    if (results.length === 0) throw new Error("Unexpected database query.");
    return Promise.resolve(results.shift());
  });
  const transaction = vi.fn(
    async (callback: (database: { execute: typeof execute }) => unknown) =>
      callback({ execute }),
  );
  return {
    database: { execute, transaction } as never,
    execute,
    transaction,
  };
}

describe("PostgreSQL Better Auth organization authority", () => {
  it("returns one exact pending invitation and rejects ambiguous invitations", async () => {
    const one = createDatabase([[{ organization_id: "org_one" }]]);
    const oneAuthority = createPostgresPreviewOrganizationAuthority(
      one.database,
      binding,
    );
    await expect(
      oneAuthority.pendingOrganizationForVerifiedEmail({
        email: "invited@example.com",
      }),
    ).resolves.toBe("org_one");

    const ambiguous = createDatabase([
      [{ organization_id: "org_one" }, { organization_id: "org_two" }],
    ]);
    const ambiguousAuthority = createPostgresPreviewOrganizationAuthority(
      ambiguous.database,
      binding,
    );
    await expect(
      ambiguousAuthority.pendingOrganizationForVerifiedEmail({
        email: "invited@example.com",
      }),
    ).resolves.toBeUndefined();
  });

  it("binds OAuth membership to the configured issuer and audience", async () => {
    const state = createDatabase([
      [{ organization_id: "org_one", workspace_id: "workspace_one" }],
      [{ organization_id: "org_one", workspace_id: "workspace_one" }],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
    );

    await expect(
      authority.activeWorkspaceForUser({
        ...binding,
        ownerUserId: "user_one",
      }),
    ).resolves.toBe("workspace_one");
    await expect(
      authority.isActiveMember({
        ...binding,
        workspaceId: "workspace_one",
        ownerUserId: "user_one",
      }),
    ).resolves.toBe(true);
    await expect(
      authority.isActiveMember({
        issuer: "https://other.example.test/api/auth",
        audience: binding.audience,
        workspaceId: "workspace_one",
        ownerUserId: "user_one",
      }),
    ).resolves.toBe(false);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("atomically accepts one verified invitation and creates one membership", async () => {
    const state = createDatabase([
      [],
      [{ email: "invited@example.com", email_verified: true }],
      [{ id: "invite_one", organization_id: "org_one", role: "member" }],
      [{ organization_id: "org_one" }],
      [],
      [{ organization_id: "org_one", workspace_id: "workspace_one" }],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
    );

    await expect(
      authority.activatePendingInvitation({
        email: "invited@example.com",
        userId: "user_one",
      }),
    ).resolves.toBe("org_one");
    expect(state.transaction).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(6);
  });

  it("returns the existing organization on an idempotent activation retry", async () => {
    const state = createDatabase([
      [{ organization_id: "org_one", workspace_id: "workspace_one" }],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
    );

    await expect(
      authority.activatePendingInvitation({
        email: "invited@example.com",
        userId: "user_one",
      }),
    ).resolves.toBe("org_one");
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the persisted user email is not verified", async () => {
    const state = createDatabase([
      [],
      [{ email: "invited@example.com", email_verified: false }],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
    );

    await expect(
      authority.activatePendingInvitation({
        email: "invited@example.com",
        userId: "user_one",
      }),
    ).rejects.toThrow("Verified invited user identity changed.");
    expect(state.execute).toHaveBeenCalledTimes(2);
  });
});
