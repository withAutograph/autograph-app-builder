import { describe, expect, it, vi } from "vitest";

import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";

const binding = {
  issuer: "https://new.autograph.so/api/auth",
  audience: "https://new.autograph.so/mcp",
  selfServiceSignupEnabled: true,
};

const user = {
  name: "Jason Morgan",
  email: "jason@example.com",
  email_verified: true,
  banned: false,
};

const organization = {
  organization_id: "organization_one",
  workspace_id: "workspace_one",
  role: "owner",
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
  it("reuses one exact active organization", async () => {
    const state = createDatabase([
      [user],
      [{ provider_id: "github" }],
      [organization],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      { ...binding, selfServiceSignupEnabled: false },
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" }),
    ).resolves.toEqual({
      organizationId: "organization_one",
      workspaceId: "workspace_one",
    });
    expect(state.transaction).toHaveBeenCalledTimes(1);
    expect(state.execute).toHaveBeenCalledTimes(3);
  });

  it("accepts one pending invitation before personal provisioning", async () => {
    const state = createDatabase([
      [user],
      [{ provider_id: "vercel" }],
      [],
      [
        {
          id: "invitation_one",
          organization_id: "organization_invited",
          role: "member",
          workspace_id: "workspace_invited",
        },
      ],
      [{ organization_id: "organization_invited" }],
      [],
      [
        {
          organization_id: "organization_invited",
          workspace_id: "workspace_invited",
          role: "member",
        },
      ],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      { ...binding, selfServiceSignupEnabled: false },
      {
        generateId: vi
          .fn()
          .mockReturnValueOnce("organization_one")
          .mockReturnValueOnce("workspace_one")
          .mockReturnValueOnce("member_one"),
      },
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" }),
    ).resolves.toEqual({
      organizationId: "organization_invited",
      workspaceId: "workspace_invited",
    });
    expect(state.execute).toHaveBeenCalledTimes(7);
  });

  it("creates one personal owner organization and mapping", async () => {
    const state = createDatabase([
      [user],
      [{ provider_id: "github" }],
      [],
      [],
      [],
      [],
      [],
      [],
      [organization],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
      {
        generateId: vi
          .fn()
          .mockReturnValueOnce("organization_one")
          .mockReturnValueOnce("workspace_one")
          .mockReturnValueOnce("member_one"),
      },
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" }),
    ).resolves.toEqual({
      organizationId: "organization_one",
      workspaceId: "workspace_one",
    });
    expect(state.execute).toHaveBeenCalledTimes(9);
  });

  it("creates a personal workspace for a passkey-verified principal", async () => {
    const state = createDatabase([
      [
        {
          ...user,
          email: "internal@passkey.autograph.invalid",
          email_verified: false,
        },
      ],
      [],
      [{ id: "passkey_one" }],
      [],
      [],
      [],
      [],
      [],
      [],
      [organization],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      { ...binding, passkeySelfServiceEnabled: true },
      {
        generateId: vi
          .fn()
          .mockReturnValueOnce("organization_one")
          .mockReturnValueOnce("workspace_one")
          .mockReturnValueOnce("member_one"),
      },
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" }),
    ).resolves.toEqual({
      organizationId: "organization_one",
      workspaceId: "workspace_one",
    });
    expect(state.execute).toHaveBeenCalledTimes(10);
  });

  it("keeps personal creation disabled while preserving existing and invited access", async () => {
    const state = createDatabase([
      [user],
      [{ provider_id: "github" }],
      [],
      [],
      [],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      { ...binding, selfServiceSignupEnabled: false },
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" }),
    ).rejects.toMatchObject({ reason: "signup-disabled" });
  });

  it.each([
    {
      name: "an unverified user",
      results: [[{ ...user, email_verified: false }], [], []],
      reason: "verified-identity-required",
    },
    {
      name: "a suspended user",
      results: [[{ ...user, banned: true }]],
      reason: "access-revoked",
    },
    {
      name: "a user without a GitHub or Vercel account",
      results: [[user], [], []],
      reason: "verified-identity-required",
    },
    {
      name: "multiple exact memberships",
      results: [
        [user],
        [{ provider_id: "github" }],
        [
          organization,
          { ...organization, organization_id: "organization_two" },
        ],
      ],
      reason: "workspace-ambiguous",
    },
    {
      name: "multiple exact invitations",
      results: [
        [user],
        [{ provider_id: "github" }],
        [],
        [
          {
            id: "invitation_one",
            organization_id: "organization_one",
            workspace_id: "workspace_one",
            role: "member",
          },
          {
            id: "invitation_two",
            organization_id: "organization_two",
            workspace_id: "workspace_two",
            role: "member",
          },
        ],
      ],
      reason: "workspace-ambiguous",
    },
    {
      name: "a revoked personal workspace membership",
      results: [
        [user],
        [{ provider_id: "github" }],
        [],
        [],
        [{ organization_id: "organization_one" }],
      ],
      reason: "access-revoked",
    },
  ] as const)("fails closed for $name", async ({ results, reason }) => {
    const state = createDatabase([...results]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
    );
    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" }),
    ).rejects.toMatchObject({ reason });
  });

  it("binds OAuth membership to the configured issuer and audience", async () => {
    const state = createDatabase([[organization], [organization]]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
    );

    await expect(
      authority.activeWorkspaceForUser({
        issuer: binding.issuer,
        audience: binding.audience,
        ownerUserId: "user_one",
      }),
    ).resolves.toBe("workspace_one");
    await expect(
      authority.isActiveMember({
        issuer: binding.issuer,
        audience: binding.audience,
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
});
