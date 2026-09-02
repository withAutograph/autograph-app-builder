import { APIError } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";

const identityCallbackPaths = new Set(["/callback/github", "/callback/vercel"]);

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

export interface PreviewVerifiedUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export type OrganizationProvisioningFailure =
  | "access-revoked"
  | "signup-disabled"
  | "verified-identity-required"
  | "workspace-ambiguous"
  | "workspace-setup-failed";

export class OrganizationProvisioningError extends Error {
  readonly reason: OrganizationProvisioningFailure;

  constructor(reason: OrganizationProvisioningFailure, options?: ErrorOptions) {
    super(reason, options);
    this.name = "OrganizationProvisioningError";
    this.reason = reason;
  }
}

export interface EnsuredOrganization {
  organizationId: string;
  workspaceId: string;
}

/**
 * Transactional persistence boundary for server-owned Better Auth workspace
 * provisioning. Implementations must lock the persisted user, validate one
 * verified GitHub or Vercel account, prefer one exact invitation, and return
 * one exact issuer/resource-bound membership.
 */
export interface PreviewOrganizationUserAuthority {
  ensureOrganizationForVerifiedUser(input: {
    userId: string;
  }): Promise<EnsuredOrganization>;
}

function identityUnavailable() {
  return APIError.from("FORBIDDEN", {
    code: "AUTOGRAPH_VERIFIED_IDENTITY_REQUIRED",
    message:
      "Your sign-in provider must share a verified email address before Autograph can set up your workspace.",
  });
}

function organizationError(cause: unknown) {
  if (!(cause instanceof OrganizationProvisioningError)) {
    return APIError.from("SERVICE_UNAVAILABLE", {
      code: "AUTOGRAPH_WORKSPACE_SETUP_FAILED",
      message:
        "We couldn’t finish setting up your workspace. Try signing in again.",
    });
  }
  switch (cause.reason) {
    case "access-revoked":
      return APIError.from("FORBIDDEN", {
        code: "AUTOGRAPH_WORKSPACE_ACCESS_REVOKED",
        message:
          "Your access to this Autograph workspace has been suspended or revoked.",
      });
    case "signup-disabled":
      return APIError.from("FORBIDDEN", {
        code: "AUTOGRAPH_SIGNUP_UNAVAILABLE",
        message: "New Autograph workspaces are not available yet.",
      });
    case "verified-identity-required":
      return identityUnavailable();
    case "workspace-ambiguous":
      return APIError.from("CONFLICT", {
        code: "AUTOGRAPH_WORKSPACE_AMBIGUOUS",
        message:
          "We found more than one workspace for this account. Choose an existing workspace or contact support.",
      });
    case "workspace-setup-failed":
      return APIError.from("SERVICE_UNAVAILABLE", {
        code: "AUTOGRAPH_WORKSPACE_SETUP_FAILED",
        message:
          "We couldn’t finish setting up your workspace. Try signing in again.",
      });
  }
}

export function createPreviewUserManagementLifecycle(
  authority: PreviewOrganizationUserAuthority,
) {
  return {
    async beforeUserCreate(
      user: PreviewVerifiedUser & Record<string, unknown>,
      context: { path?: string } | null,
    ) {
      if (!identityCallbackPaths.has(context?.path ?? "")) return;
      if (!user.emailVerified) throw identityUnavailable();
      return {
        data: {
          ...user,
          email: user.email.trim().toLowerCase(),
        },
      };
    },

    async beforeSessionCreate<T extends { userId: string }>(
      session: T,
      context?: { path?: string } | null,
    ) {
      // Passkey onboarding provisions its organization and activates it using
      // the same adapter transaction that creates the credential and session.
      if (context?.path === "/passkey/verify-registration") return;
      try {
        const ensured = await authority.ensureOrganizationForVerifiedUser({
          userId: session.userId,
        });
        return {
          data: {
            ...session,
            activeOrganizationId: ensured.organizationId,
          },
        };
      } catch (cause) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "preview_workspace_session_provisioning_failed",
            reason:
              cause instanceof OrganizationProvisioningError
                ? cause.reason
                : "unexpected",
          }),
        );
        throw organizationError(cause);
      }
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
      // Better Auth defaults to a 100-member organization ceiling when this
      // option is omitted. App Builder does not impose a product membership
      // quota, so use the largest exactly representable integer instead.
      membershipLimit: Number.MAX_SAFE_INTEGER,
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
      id: "autograph-self-serve-workspace",
      init() {
        return {
          options: {
            databaseHooks: {
              user: {
                create: {
                  before: lifecycle.beforeUserCreate,
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
