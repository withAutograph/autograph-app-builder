import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type { PreviewOAuthMembershipAuthority } from "./preview-oauth-contract";
import { OrganizationProvisioningError } from "./preview-user-management";
import type {
  EnsuredOrganization,
  PreviewOrganizationUserAuthority,
} from "./preview-user-management";

type Database = PostgresJsDatabase;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PostgresQueryResult = readonly unknown[] | { readonly rows: readonly unknown[] };

const WORKSPACE_SETUP_FAILED = "workspace-setup-failed";
const WORKSPACE_AMBIGUOUS = "workspace-ambiguous";
const ACCESS_REVOKED = "access-revoked";
const organizationRowSchema = z.object({
  organization_id: z.string(),
  role: z.string(),
  workspace_id: z.string(),
});

interface OrganizationRow {
  organization_id: string;
  workspace_id: string;
  role: string;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function resultRows<Row>(input: PostgresQueryResult, rowSchema: z.ZodType<Row>): readonly Row[] {
  let queryRows: readonly unknown[];
  if (Array.isArray(input)) {
    queryRows = input;
  } else if ("rows" in input && Array.isArray(input.rows)) {
    const { rows } = input;
    queryRows = rows;
  } else {
    throw new Error("PostgreSQL returned an unsupported organization result.");
  }
  return z.array(rowSchema).parse(queryRows);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function activeOrganizations(
  database: Database | Transaction,
  authority: { issuer: string; audience: string },
  userId: string,
) {
  const result = await database.execute(sql`
    select "member"."organization_id", "organization"."workspace_id", "member"."role"
      from "member"
      join "organization"
        on "organization"."id" = "member"."organization_id"
     where "member"."user_id" = ${userId}
       and "organization"."issuer" = ${authority.issuer}
       and "organization"."audience" = ${authority.audience}
     order by "member"."organization_id"
     limit 2
  `);
  return resultRows(result, organizationRowSchema);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function oneAuthorizedOrganization(
  rows: readonly OrganizationRow[],
): EnsuredOrganization | undefined {
  if (rows.length !== 1 || rows[0] === undefined) {
    return undefined;
  }
  if (!new Set(["owner", "admin", "member"]).has(rows[0].role)) {
    throw new OrganizationProvisioningError(ACCESS_REVOKED);
  }
  return {
    organizationId: rows[0].organization_id,
    workspaceId: rows[0].workspace_id,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function exactActiveOrganization(
  database: Database | Transaction,
  authority: { issuer: string; audience: string },
  userId: string,
) {
  return oneAuthorizedOrganization(await activeOrganizations(database, authority, userId));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function personalWorkspaceSlug(userId: string) {
  const digest = createHash("sha256").update(userId).digest("hex");
  return `personal-${digest.slice(0, 24)}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function personalWorkspaceName(name: string) {
  const [firstName] = name.trim().split(/\s+/u);
  return firstName ? `${firstName}’s Workspace` : "My Workspace";
}

export type PostgresPreviewOrganizationAuthority = PreviewOrganizationUserAuthority &
  PreviewOAuthMembershipAuthority;

/**
 * Better Auth organization authority used by login and OAuth token issuance.
 * First-session workspace provisioning is serialized by a row lock and is
 * fully transaction-bound, so a callback crash or retry cannot leave partial
 * organization state or create a duplicate personal workspace.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresPreviewOrganizationAuthority(
  database: Database,
  authority: {
    issuer: string;
    audience: string;
  },
  options: {
    generateId?: () => string;
    isSelfServiceSignupEnabled?: () => Promise<boolean>;
  } = {},
): PostgresPreviewOrganizationAuthority {
  const generateId = options.generateId ?? randomUUID;
  return {
    async activeWorkspaceForUser({ issuer, audience, ownerUserId }) {
      const activeOrganization =
        issuer === authority.issuer && audience === authority.audience
          ? await exactActiveOrganization(database, authority, ownerUserId)
          : undefined;
      return activeOrganization?.workspaceId;
    },

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async ensureOrganizationForVerifiedUser({ userId }) {
      return await database.transaction(async (transaction) => {
        const userResult = await transaction.execute(sql`
          select "name", "email", "email_verified", "banned"
            from "user"
           where "id" = ${userId}
           for update
        `);
        const users = resultRows(
          userResult,
          z.object({
            banned: z.boolean().nullable(),
            email: z.string(),
            email_verified: z.boolean(),
            name: z.string(),
          }),
        );
        const [user] = users;
        if (users.length !== 1 || user === undefined) {
          throw new OrganizationProvisioningError(WORKSPACE_SETUP_FAILED);
        }
        if (user.banned === true) {
          throw new OrganizationProvisioningError(ACCESS_REVOKED);
        }
        const accountsResult = await transaction.execute(sql`
          select "provider_id"
            from "account"
           where "user_id" = ${userId}
             and "provider_id" in ('github', 'vercel')
           order by "provider_id"
           limit 2
        `);
        const providerIdentity =
          resultRows(accountsResult, z.object({ provider_id: z.string() })).length > 0 &&
          user.email_verified &&
          user.email.trim().toLowerCase() === user.email;
        let passkeyIdentity = false;
        if (!providerIdentity) {
          const passkeysResult = await transaction.execute(sql`
            select "id"
              from "passkey"
             where "user_id" = ${userId}
             limit 1
          `);
          passkeyIdentity = resultRows(passkeysResult, z.object({ id: z.string() })).length === 1;
        }
        if (!providerIdentity && !passkeyIdentity) {
          throw new OrganizationProvisioningError("verified-identity-required");
        }

        const memberships = await activeOrganizations(transaction, authority, userId);
        if (memberships.length > 1) {
          throw new OrganizationProvisioningError(WORKSPACE_AMBIGUOUS);
        }
        const existing = oneAuthorizedOrganization(memberships);
        if (existing !== undefined) {
          return existing;
        }

        const invitationResult = await transaction.execute(sql`
          select "invitation"."id", "invitation"."organization_id",
                 "invitation"."role", "organization"."workspace_id"
            from "invitation"
            join "organization"
              on "organization"."id" = "invitation"."organization_id"
           where lower("invitation"."email") = ${user.email}
             and "invitation"."status" = 'pending'
             and "invitation"."expires_at" > clock_timestamp()
             and "organization"."issuer" = ${authority.issuer}
             and "organization"."audience" = ${authority.audience}
           order by "invitation"."organization_id", "invitation"."id"
           limit 2
           for update of "invitation"
        `);
        const invitations = resultRows(
          invitationResult,
          z.object({
            id: z.string(),
            organization_id: z.string(),
            role: z.string().nullable(),
            workspace_id: z.string(),
          }),
        );
        if (invitations.length > 1) {
          throw new OrganizationProvisioningError(WORKSPACE_AMBIGUOUS);
        }
        const [invitation] = invitations;
        if (invitation !== undefined) {
          const role = invitation.role ?? "member";
          if (!new Set(["owner", "admin", "member"]).has(role)) {
            throw new OrganizationProvisioningError(ACCESS_REVOKED);
          }
          const acceptedResult = await transaction.execute(sql`
            update "invitation"
               set "status" = 'accepted'
             where "id" = ${invitation.id}
               and "status" = 'pending'
            returning "organization_id"
          `);
          if (resultRows(acceptedResult, z.object({ organization_id: z.string() })).length !== 1) {
            throw new OrganizationProvisioningError(WORKSPACE_SETUP_FAILED);
          }
          await transaction.execute(sql`
            insert into "member" (
              "id", "organization_id", "user_id", "role", "created_at"
            ) values (
              ${generateId()}, ${invitation.organization_id}, ${userId},
              ${role}, clock_timestamp()
            )
            on conflict ("organization_id", "user_id") do nothing
          `);
          const invitedMemberships = await activeOrganizations(transaction, authority, userId);
          const invited = oneAuthorizedOrganization(invitedMemberships);
          if (
            invitedMemberships.length !== 1 ||
            invited?.organizationId !== invitation.organization_id ||
            invited.workspaceId !== invitation.workspace_id
          ) {
            throw new OrganizationProvisioningError(WORKSPACE_SETUP_FAILED);
          }
          return invited;
        }

        const mappingResult = await transaction.execute(sql`
          select "organization_id"
            from "personal_workspace"
           where "user_id" = ${userId}
           limit 2
        `);
        if (resultRows(mappingResult, z.object({ organization_id: z.string() })).length !== 0) {
          throw new OrganizationProvisioningError(ACCESS_REVOKED);
        }
        let selfServiceSignupEnabled = false;
        try {
          selfServiceSignupEnabled = (await options.isSelfServiceSignupEnabled?.()) === true;
        } catch {
          // Treat an unavailable feature flag as disabled.
        }
        if (!selfServiceSignupEnabled) {
          throw new OrganizationProvisioningError("signup-disabled");
        }

        const organizationId = generateId();
        const workspaceId = generateId();
        await transaction.execute(sql`
          insert into "organization" (
            "id", "name", "slug", "created_at", "issuer", "audience", "workspace_id"
          ) values (
            ${organizationId}, ${personalWorkspaceName(user.name)},
            ${personalWorkspaceSlug(userId)}, clock_timestamp(),
            ${authority.issuer}, ${authority.audience}, ${workspaceId}
          )
        `);
        await transaction.execute(sql`
          insert into "member" (
            "id", "organization_id", "user_id", "role", "created_at"
          ) values (
            ${generateId()}, ${organizationId}, ${userId}, 'owner', clock_timestamp()
          )
        `);
        await transaction.execute(sql`
          insert into "personal_workspace" (
            "user_id", "organization_id", "created_at"
          ) values (${userId}, ${organizationId}, clock_timestamp())
        `);
        const createdMemberships = await activeOrganizations(transaction, authority, userId);
        const created = oneAuthorizedOrganization(createdMemberships);
        if (
          createdMemberships.length !== 1 ||
          created?.organizationId !== organizationId ||
          created.workspaceId !== workspaceId
        ) {
          throw new OrganizationProvisioningError(WORKSPACE_SETUP_FAILED);
        }
        return created;
      });
    },

    async isActiveMember({ issuer, audience, workspaceId, ownerUserId }) {
      if (issuer !== authority.issuer || audience !== authority.audience) {
        return false;
      }
      const activeOrganization = await exactActiveOrganization(database, authority, ownerUserId);
      return activeOrganization?.workspaceId === workspaceId;
    },
  };
}
