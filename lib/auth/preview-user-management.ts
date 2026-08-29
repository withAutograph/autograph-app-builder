import { APIError } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";

const githubCallbackPath = "/callback/github";

const organizationAccess = createAccessControl({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

const organizationRoles = {
  owner: organizationAccess.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  admin: organizationAccess.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  member: organizationAccess.newRole({
    organization: [],
    member: [],
    invitation: [],
  }),
};

export interface PreviewInvitedUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Atomic persistence boundary for the Better Auth organization tables.
 *
 * Implementations must treat zero or multiple pending invitations and zero or
 * multiple active memberships as `undefined`. Activating an invitation must
 * compare-and-set one pending invitation, create at most one member row, and
 * return the same organization for an idempotent retry.
 */
export interface PreviewOrganizationUserAuthority {
  pendingOrganizationForVerifiedEmail(input: {
    email: string;
  }): Promise<string | undefined>;
  activatePendingInvitation(input: {
    email: string;
    userId: string;
  }): Promise<string>;
  activeOrganizationForUser(input: {
    userId: string;
  }): Promise<string | undefined>;
}

function accessDenied(message: string) {
  return APIError.from("FORBIDDEN", {
    code: "AUTOGRAPH_INVITATION_REQUIRED",
    message,
  });
}

function organizationUnavailable() {
  return APIError.from("FORBIDDEN", {
    code: "AUTOGRAPH_WORKSPACE_UNAVAILABLE",
    message:
      "Your Autograph workspace is not available. Ask a workspace owner to review your access.",
  });
}

export function createPreviewUserManagementLifecycle(
  authority: PreviewOrganizationUserAuthority,
) {
  return {
    async beforeUserCreate(
      user: PreviewInvitedUser & Record<string, unknown>,
      context: { path?: string } | null,
    ) {
      if (context?.path !== githubCallbackPath) return;
      if (!user.emailVerified) {
        throw accessDenied(
          "GitHub must provide a verified email address before you can join Autograph.",
        );
      }
      const organizationId =
        await authority.pendingOrganizationForVerifiedEmail({
          email: user.email.toLowerCase(),
        });
      if (organizationId === undefined) {
        throw accessDenied(
          "This GitHub account does not have an active Autograph invitation.",
        );
      }
    },

    async afterUserCreate(
      user: PreviewInvitedUser & Record<string, unknown>,
      context: { path?: string } | null,
    ) {
      if (context?.path !== githubCallbackPath) return;
      await authority.activatePendingInvitation({
        email: user.email.toLowerCase(),
        userId: user.id,
      });
    },

    async beforeSessionCreate<T extends { userId: string }>(session: T) {
      const activeOrganizationId = await authority.activeOrganizationForUser({
        userId: session.userId,
      });
      if (activeOrganizationId === undefined) {
        throw organizationUnavailable();
      }
      return {
        data: {
          ...session,
          activeOrganizationId,
        },
      };
    },
  };
}

export function previewUserManagementPlugins(
  authority: PreviewOrganizationUserAuthority,
) {
  const lifecycle = createPreviewUserManagementLifecycle(authority);
  return [
    organization({
      ac: organizationAccess,
      roles: organizationRoles,
      creatorRole: "owner",
      allowUserToCreateOrganization: false,
      membershipLimit: 100,
      invitationExpiresIn: 60 * 60 * 48,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      schema: {
        organization: {
          additionalFields: {
            issuer: {
              type: "string",
              required: true,
              input: false,
              fieldName: "issuer",
            },
            audience: {
              type: "string",
              required: true,
              input: false,
              fieldName: "audience",
            },
            workspaceId: {
              type: "string",
              required: true,
              input: false,
              fieldName: "workspace_id",
            },
          },
        },
      },
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    {
      id: "autograph-preview-invited-user",
      init() {
        return {
          options: {
            databaseHooks: {
              user: {
                create: {
                  before: lifecycle.beforeUserCreate,
                  after: lifecycle.afterUserCreate,
                },
              },
              session: {
                create: {
                  before: lifecycle.beforeSessionCreate,
                },
              },
            },
          },
        };
      },
    },
  ] as const;
}
