import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as databaseSchema from "../db/schema";
import { member, organization, user } from "../db/schema";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import { hostedPrincipalSchema } from "./hosted-auth";

type Database = PostgresJsDatabase<typeof databaseSchema>;

/**
 * Request-time membership authority. A signed workspace claim selects the
 * tenant, but only a currently active exact user/workspace row admits it.
 * Missing rows, revoked rows, and database errors all fail closed.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresWorkspaceMembership(database: Database): HostedWorkspaceMembership {
  return {
    async isMember({ principal: principalInput, workspaceId }) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      if (workspaceId !== principal.workspaceId) return false;
      const rows = await database
        .select({ role: member.role, banned: user.banned })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(organization.issuer, principal.issuer),
            eq(organization.audience, principal.audience),
            eq(organization.workspaceId, principal.workspaceId),
            eq(member.userId, principal.ownerUserId),
          ),
        )
        .limit(2);
      return (
        rows.length === 1 &&
        rows[0]?.banned !== true &&
        new Set(["owner", "admin", "member"]).has(rows[0]?.role ?? "")
      );
    },
  };
}

/** Consent-time authority for the future Preview issuer. Exactly one active
 * workspace is required; zero or multiple rows fail closed without guessing. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresOAuthMembershipAuthority(database: Database) {
  return {
    async activeWorkspaceForUser(input: {
      issuer: string;
      audience: string;
      ownerUserId: string;
    }): Promise<string | undefined> {
      const rows = await database
        .select({
          workspaceId: organization.workspaceId,
          role: member.role,
          banned: user.banned,
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(
            eq(organization.issuer, input.issuer),
            eq(organization.audience, input.audience),
            eq(member.userId, input.ownerUserId),
          ),
        )
        .limit(2);
      return rows.length === 1 &&
        rows[0]?.banned !== true &&
        new Set(["owner", "admin", "member"]).has(rows[0]?.role ?? "")
        ? rows[0]?.workspaceId
        : undefined;
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async isActiveMember(input: {
      issuer: string;
      audience: string;
      workspaceId: string;
      ownerUserId: string;
    }): Promise<boolean> {
      return createPostgresWorkspaceMembership(database).isMember({
        principal: {
          issuer: input.issuer,
          audience: input.audience,
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          scopes: ["autograph:session"],
        },
        workspaceId: input.workspaceId,
      });
    },
  };
}
