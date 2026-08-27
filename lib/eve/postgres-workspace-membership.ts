import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as databaseSchema from "../db/schema";
import { hostedWorkspaceMemberships } from "../db/schema";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import { hostedPrincipalSchema } from "./hosted-auth";

type Database = PostgresJsDatabase<typeof databaseSchema>;

/**
 * Request-time membership authority. A signed workspace claim selects the
 * tenant, but only a currently active exact user/workspace row admits it.
 * Missing rows, revoked rows, and database errors all fail closed.
 */
export function createPostgresWorkspaceMembership(
  database: Database,
): HostedWorkspaceMembership {
  return {
    async isMember({ principal: principalInput, workspaceId }) {
      const principal = hostedPrincipalSchema.parse(principalInput);
      if (workspaceId !== principal.workspaceId) return false;
      const rows = await database
        .select({ active: hostedWorkspaceMemberships.active })
        .from(hostedWorkspaceMemberships)
        .where(
          and(
            eq(hostedWorkspaceMemberships.issuer, principal.issuer),
            eq(hostedWorkspaceMemberships.audience, principal.audience),
            eq(hostedWorkspaceMemberships.workspaceId, principal.workspaceId),
            eq(hostedWorkspaceMemberships.ownerUserId, principal.ownerUserId),
          ),
        )
        .limit(1);
      return rows.length === 1 && rows[0]?.active === true;
    },
  };
}

/** Consent-time authority for the future Preview issuer. Exactly one active
 * workspace is required; zero or multiple rows fail closed without guessing. */
export function createPostgresOAuthMembershipAuthority(database: Database) {
  return {
    async activeWorkspaceForUser(input: {
      issuer: string;
      audience: string;
      ownerUserId: string;
    }): Promise<string | undefined> {
      const rows = await database
        .select({ workspaceId: hostedWorkspaceMemberships.workspaceId })
        .from(hostedWorkspaceMemberships)
        .where(
          and(
            eq(hostedWorkspaceMemberships.issuer, input.issuer),
            eq(hostedWorkspaceMemberships.audience, input.audience),
            eq(hostedWorkspaceMemberships.ownerUserId, input.ownerUserId),
            eq(hostedWorkspaceMemberships.active, true),
          ),
        )
        .limit(2);
      return rows.length === 1 ? rows[0]?.workspaceId : undefined;
    },
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
          scopes: ["eve:session"],
        },
        workspaceId: input.workspaceId,
      });
    },
  };
}
