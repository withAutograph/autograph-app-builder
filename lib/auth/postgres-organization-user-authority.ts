import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as databaseSchema from "../db/schema";
import type { PreviewOAuthMembershipAuthority } from "./preview-oauth-contract";
import type { PreviewOrganizationUserAuthority } from "./preview-user-management";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface OrganizationRow {
  organization_id: string;
}

function resultRows<T>(input: unknown): readonly T[] {
  if (Array.isArray(input)) return input as T[];
  if (
    typeof input === "object" &&
    input !== null &&
    "rows" in input &&
    Array.isArray(input.rows)
  ) {
    return input.rows as T[];
  }
  throw new Error("PostgreSQL returned an unsupported organization result.");
}

async function exactActiveOrganization(
  database: Database | Transaction,
  authority: { issuer: string; audience: string },
  userId: string,
) {
  const result = await database.execute(sql`
    select "member"."organization_id", "organization"."workspace_id"
      from "member"
      join "organization"
        on "organization"."id" = "member"."organization_id"
     where "member"."user_id" = ${userId}
       and "organization"."issuer" = ${authority.issuer}
       and "organization"."audience" = ${authority.audience}
     order by "member"."organization_id"
     limit 2
  `);
  const rows = resultRows<OrganizationRow & { workspace_id: string }>(result);
  return rows.length === 1 ? rows[0] : undefined;
}

export type PostgresPreviewOrganizationAuthority =
  PreviewOrganizationUserAuthority & PreviewOAuthMembershipAuthority;

/**
 * Better Auth organization/member/invitation authority used by both login and
 * OAuth token issuance. Invitation activation is transaction-bound and
 * idempotent; active membership is re-read for every consent/token decision.
 */
export function createPostgresPreviewOrganizationAuthority(
  database: Database,
  authority: { issuer: string; audience: string },
): PostgresPreviewOrganizationAuthority {
  return {
    async pendingOrganizationForVerifiedEmail({ email }) {
      const result = await database.execute(sql`
        select "invitation"."organization_id"
          from "invitation"
          join "organization"
            on "organization"."id" = "invitation"."organization_id"
         where lower("email") = lower(${email})
           and "invitation"."status" = 'pending'
           and "invitation"."expires_at" > clock_timestamp()
           and "organization"."issuer" = ${authority.issuer}
           and "organization"."audience" = ${authority.audience}
         order by "invitation"."organization_id", "invitation"."id"
         limit 2
      `);
      const rows = resultRows<OrganizationRow>(result);
      return rows.length === 1 ? rows[0]?.organization_id : undefined;
    },

    async activatePendingInvitation({ email, userId }) {
      return database.transaction(async (transaction) => {
        const existing = await exactActiveOrganization(
          transaction,
          authority,
          userId,
        );
        if (existing !== undefined) return existing.organization_id;

        const userResult = await transaction.execute(sql`
          select "email", "email_verified"
            from "user"
           where "id" = ${userId}
           for update
        `);
        const users = resultRows<{
          email: string;
          email_verified: boolean;
        }>(userResult);
        if (
          users.length !== 1 ||
          users[0]?.email_verified !== true ||
          users[0]?.email.toLowerCase() !== email.toLowerCase()
        ) {
          throw new Error("Verified invited user identity changed.");
        }

        const invitationResult = await transaction.execute(sql`
          select "invitation"."id", "invitation"."organization_id", "invitation"."role"
            from "invitation"
            join "organization"
              on "organization"."id" = "invitation"."organization_id"
           where lower("email") = lower(${email})
             and "invitation"."status" = 'pending'
             and "invitation"."expires_at" > clock_timestamp()
             and "organization"."issuer" = ${authority.issuer}
             and "organization"."audience" = ${authority.audience}
           order by "invitation"."organization_id", "invitation"."id"
           limit 2
           for update
        `);
        const invitations = resultRows<{
          id: string;
          organization_id: string;
          role: string;
        }>(invitationResult);
        if (invitations.length !== 1 || invitations[0] === undefined) {
          throw new Error("Exactly one active invitation is required.");
        }
        const invitation = invitations[0];

        const acceptedResult = await transaction.execute(sql`
          update "invitation"
             set "status" = 'accepted'
           where "id" = ${invitation.id}
             and "status" = 'pending'
          returning "organization_id"
        `);
        if (resultRows<OrganizationRow>(acceptedResult).length !== 1) {
          throw new Error("Invitation was already resolved.");
        }

        await transaction.execute(sql`
          insert into "member" (
            "id", "organization_id", "user_id", "role", "created_at"
          ) values (
            ${randomUUID()}, ${invitation.organization_id}, ${userId},
            ${invitation.role}, clock_timestamp()
          )
          on conflict ("organization_id", "user_id") do nothing
        `);
        const active = await exactActiveOrganization(
          transaction,
          authority,
          userId,
        );
        if (active?.organization_id !== invitation.organization_id) {
          throw new Error("Invitation did not create one active membership.");
        }
        return active.organization_id;
      });
    },

    async activeOrganizationForUser({ userId }) {
      return (await exactActiveOrganization(database, authority, userId))
        ?.organization_id;
    },

    async activeWorkspaceForUser({ issuer, audience, ownerUserId }) {
      if (issuer !== authority.issuer || audience !== authority.audience) {
        return undefined;
      }
      return (await exactActiveOrganization(database, authority, ownerUserId))
        ?.workspace_id;
    },

    async isActiveMember({ issuer, audience, workspaceId, ownerUserId }) {
      if (issuer !== authority.issuer || audience !== authority.audience) {
        return false;
      }
      return (
        (await exactActiveOrganization(database, authority, ownerUserId))
          ?.workspace_id === workspaceId
      );
    },
  };
}
