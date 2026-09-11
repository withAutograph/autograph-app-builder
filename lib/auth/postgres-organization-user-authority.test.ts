import { describe, expect, it, vi } from "vitest";

import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";

const binding = {
  audience: "https://new.autograph.so/mcp",
  issuer: "https://new.autograph.so/api/auth",
};

const user = {
  banned: false,
  email: "jason@example.com",
  email_verified: true,
  name: "Jason Morgan",
};

const organization = {
  organization_id: "organization_one",
  role: "owner",
  workspace_id: "workspace_one",
};

function createDatabase(results: unknown[]) {
  const execute = vi.fn(async () => {
    if (results.length === 0) {
      throw new Error("Unexpected database query.");
    }
    return results.shift();
  });
  const transaction = vi.fn(
    async (callback: (database: { execute: typeof execute }) => unknown) =>
      callback({ execute })
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
      binding
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
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
          role: "member",
          workspace_id: "workspace_invited",
        },
      ],
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
      }
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
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
        isSelfServiceSignupEnabled: vi.fn(async () => true),
      }
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
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
      binding,
      {
        generateId: vi
          .fn()
          .mockReturnValueOnce("organization_one")
          .mockReturnValueOnce("workspace_one")
          .mockReturnValueOnce("member_one"),
        isSelfServiceSignupEnabled: vi.fn(async () => true),
      }
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
    ).resolves.toEqual({
      organizationId: "organization_one",
      workspaceId: "workspace_one",
    });
    expect(state.execute).toHaveBeenCalledTimes(10);
  });

  it("requires the self-service flag for a passkey-verified principal", async () => {
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
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
    ).rejects.toMatchObject({ reason: "signup-disabled" });
    expect(state.execute).toHaveBeenCalledTimes(6);
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
      binding
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
    ).rejects.toMatchObject({ reason: "signup-disabled" });
    expect(state.execute).toHaveBeenCalledTimes(5);
  });

  it("fails closed when self-service signup cannot be evaluated", async () => {
    const state = createDatabase([
      [user],
      [{ provider_id: "github" }],
      [],
      [],
      [],
    ]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding,
      {
        isSelfServiceSignupEnabled: vi.fn(async () => {
          throw new Error("feature flags unavailable");
        }),
      }
    );

    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
    ).rejects.toMatchObject({ reason: "signup-disabled" });
    expect(state.execute).toHaveBeenCalledTimes(5);
  });

  it.each([
    {
      name: "an unverified user",
      reason: "verified-identity-required",
      results: [[{ ...user, email_verified: false }], [], []],
    },
    {
      name: "a suspended user",
      reason: "access-revoked",
      results: [[{ ...user, banned: true }]],
    },
    {
      name: "a user without a GitHub or Vercel account",
      reason: "verified-identity-required",
      results: [[user], [], []],
    },
    {
      name: "multiple exact memberships",
      reason: "workspace-ambiguous",
      results: [
        [user],
        [{ provider_id: "github" }],
        [
          organization,
          { ...organization, organization_id: "organization_two" },
        ],
      ],
    },
    {
      name: "multiple exact invitations",
      reason: "workspace-ambiguous",
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
    },
    {
      name: "a revoked personal workspace membership",
      reason: "access-revoked",
      results: [
        [user],
        [{ provider_id: "github" }],
        [],
        [],
        [{ organization_id: "organization_one" }],
      ],
    },
  ] as const)("fails closed for $name", async ({ results, reason }) => {
    const state = createDatabase([...results]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding
    );
    await expect(
      authority.ensureOrganizationForVerifiedUser({ userId: "user_one" })
    ).rejects.toMatchObject({ reason });
  });

  it("binds OAuth membership to the configured issuer and audience", async () => {
    const state = createDatabase([[organization], [organization]]);
    const authority = createPostgresPreviewOrganizationAuthority(
      state.database,
      binding
    );

    await expect(
      authority.activeWorkspaceForUser({
        audience: binding.audience,
        issuer: binding.issuer,
        ownerUserId: "user_one",
      })
    ).resolves.toBe("workspace_one");
    await expect(
      authority.isActiveMember({
        audience: binding.audience,
        issuer: binding.issuer,
        ownerUserId: "user_one",
        workspaceId: "workspace_one",
      })
    ).resolves.toBe(true);
    await expect(
      authority.isActiveMember({
        audience: binding.audience,
        issuer: "https://other.example.test/api/auth",
        ownerUserId: "user_one",
        workspaceId: "workspace_one",
      })
    ).resolves.toBe(false);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });
});
