import { and, eq, lt, lte, ne, notExists } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  agentOperations,
  agentSessions,
  githubInstallationAuthorizationStates,
  hostedGitHubInstallationBindings,
  hostedGitHubInstallations,
  hostedVercelInstallations,
  hostedWorkspaceMemberships,
  vercelInstallationAuthorizationStates,
} from "./schema";
import * as databaseSchema from "./schema";
import type { HostedAdminStore } from "./hosted-admin";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function membershipPredicate(
  authority: Parameters<HostedAdminStore["seedMembership"]>[0]["authority"],
) {
  return and(
    eq(hostedWorkspaceMemberships.issuer, authority.issuer),
    eq(hostedWorkspaceMemberships.audience, authority.audience),
    eq(hostedWorkspaceMemberships.workspaceId, authority.workspaceId),
    eq(hostedWorkspaceMemberships.ownerUserId, authority.ownerUserId),
  );
}

function operationTenantPredicate(
  authority: Parameters<HostedAdminStore["seedMembership"]>[0]["authority"],
) {
  return and(
    eq(agentOperations.issuer, authority.issuer),
    eq(agentOperations.audience, authority.audience),
    eq(agentOperations.workspaceId, authority.workspaceId),
    eq(agentOperations.ownerUserId, authority.ownerUserId),
  );
}

function sessionTenantPredicate(
  authority: Parameters<HostedAdminStore["seedMembership"]>[0]["authority"],
) {
  return and(
    eq(agentSessions.issuer, authority.issuer),
    eq(agentSessions.audience, authority.audience),
    eq(agentSessions.workspaceId, authority.workspaceId),
    eq(agentSessions.ownerUserId, authority.ownerUserId),
  );
}

function integrationTenantPredicate(
  table:
    | typeof hostedGitHubInstallations
    | typeof hostedGitHubInstallationBindings
    | typeof hostedVercelInstallations
    | typeof githubInstallationAuthorizationStates
    | typeof vercelInstallationAuthorizationStates,
  authority: Parameters<HostedAdminStore["seedMembership"]>[0]["authority"],
) {
  return and(
    eq(table.issuer, authority.issuer),
    eq(table.audience, authority.audience),
    eq(table.workspaceId, authority.workspaceId),
    eq(table.ownerUserId, authority.ownerUserId),
  );
}

async function deleteExpired(
  transaction: Transaction,
  input: Parameters<HostedAdminStore["applyRetention"]>[0],
) {
  // Reserved rows are replay authority after an interrupted submission and are
  // never age-deleted. A session is deleted only after every operation that
  // still references it has been removed.
  const operations = await transaction
    .delete(agentOperations)
    .where(
      and(
        operationTenantPredicate(input.authority),
        lt(agentOperations.updatedAt, input.deleteBefore),
        ne(agentOperations.state, "reserved"),
      ),
    )
    .returning({ operationId: agentOperations.operationId });

  const sessions = await transaction
    .delete(agentSessions)
    .where(
      and(
        sessionTenantPredicate(input.authority),
        lt(agentSessions.updatedAt, input.deleteBefore),
        notExists(
          transaction
            .select({ operationId: agentOperations.operationId })
            .from(agentOperations)
            .where(
              and(
                eq(agentOperations.issuer, agentSessions.issuer),
                eq(agentOperations.audience, agentSessions.audience),
                eq(agentOperations.workspaceId, agentSessions.workspaceId),
                eq(agentOperations.ownerUserId, agentSessions.ownerUserId),
                eq(agentOperations.sessionId, agentSessions.sessionId),
              ),
            ),
        ),
      ),
    )
    .returning({ sessionId: agentSessions.sessionId });

  const githubStates = await transaction
    .delete(githubInstallationAuthorizationStates)
    .where(
      and(
        integrationTenantPredicate(
          githubInstallationAuthorizationStates,
          input.authority,
        ),
        lt(githubInstallationAuthorizationStates.expiresAt, input.deleteBefore),
      ),
    )
    .returning({
      stateDigest: githubInstallationAuthorizationStates.stateDigest,
    });
  const vercelStates = await transaction
    .delete(vercelInstallationAuthorizationStates)
    .where(
      and(
        integrationTenantPredicate(
          vercelInstallationAuthorizationStates,
          input.authority,
        ),
        lt(vercelInstallationAuthorizationStates.expiresAt, input.deleteBefore),
      ),
    )
    .returning({
      stateDigest: vercelInstallationAuthorizationStates.stateDigest,
    });

  return {
    operationRowsDeleted: operations.length,
    sessionRowsDeleted: sessions.length,
    integrationRowsDeleted: 0,
    authorizationStateRowsDeleted: githubStates.length + vercelStates.length,
  };
}

export function createPostgresHostedAdminStore(
  database: Database,
): HostedAdminStore {
  return {
    async seedMembership({ authority, now }) {
      const rows = await database
        .insert(hostedWorkspaceMemberships)
        .values({ ...authority, active: true, updatedAt: now })
        .onConflictDoUpdate({
          target: [
            hostedWorkspaceMemberships.issuer,
            hostedWorkspaceMemberships.audience,
            hostedWorkspaceMemberships.workspaceId,
            hostedWorkspaceMemberships.ownerUserId,
          ],
          set: { active: true, updatedAt: now },
        })
        .returning({ workspaceId: hostedWorkspaceMemberships.workspaceId });
      if (rows.length !== 1) {
        throw new Error("Hosted membership activation was not durable.");
      }
      return { membershipRowsAffected: 1 };
    },

    async revokeMembership({ authority, now }) {
      const rows = await database
        .update(hostedWorkspaceMemberships)
        .set({ active: false, updatedAt: now })
        .where(
          and(
            membershipPredicate(authority),
            eq(hostedWorkspaceMemberships.active, true),
          ),
        )
        .returning({ workspaceId: hostedWorkspaceMemberships.workspaceId });
      return { membershipRowsAffected: rows.length };
    },

    applyRetention(input) {
      return database.transaction((transaction) =>
        deleteExpired(transaction, input),
      );
    },

    async deleteTenant({ authority, membershipRevokedBefore }) {
      return database.transaction(async (transaction) => {
        const inactiveMembership = await transaction
          .select({ workspaceId: hostedWorkspaceMemberships.workspaceId })
          .from(hostedWorkspaceMemberships)
          .where(
            and(
              membershipPredicate(authority),
              eq(hostedWorkspaceMemberships.active, false),
              lte(
                hostedWorkspaceMemberships.updatedAt,
                membershipRevokedBefore,
              ),
            ),
          )
          .limit(1)
          .for("update");
        if (inactiveMembership.length !== 1) {
          throw new Error(
            "Hosted tenant deletion requires a drained inactive membership.",
          );
        }

        const operations = await transaction
          .delete(agentOperations)
          .where(operationTenantPredicate(authority))
          .returning({ operationId: agentOperations.operationId });
        const sessions = await transaction
          .delete(agentSessions)
          .where(sessionTenantPredicate(authority))
          .returning({ sessionId: agentSessions.sessionId });
        const githubInstallations = await transaction
          .delete(hostedGitHubInstallations)
          .where(
            integrationTenantPredicate(hostedGitHubInstallations, authority),
          )
          .returning({
            installationId: hostedGitHubInstallations.installationId,
          });
        const githubBindings = await transaction
          .delete(hostedGitHubInstallationBindings)
          .where(
            integrationTenantPredicate(
              hostedGitHubInstallationBindings,
              authority,
            ),
          )
          .returning({
            installationId: hostedGitHubInstallationBindings.installationId,
          });
        const vercelInstallations = await transaction
          .delete(hostedVercelInstallations)
          .where(
            integrationTenantPredicate(hostedVercelInstallations, authority),
          )
          .returning({
            installationId: hostedVercelInstallations.installationId,
          });
        const githubStates = await transaction
          .delete(githubInstallationAuthorizationStates)
          .where(
            integrationTenantPredicate(
              githubInstallationAuthorizationStates,
              authority,
            ),
          )
          .returning({
            stateDigest: githubInstallationAuthorizationStates.stateDigest,
          });
        const vercelStates = await transaction
          .delete(vercelInstallationAuthorizationStates)
          .where(
            integrationTenantPredicate(
              vercelInstallationAuthorizationStates,
              authority,
            ),
          )
          .returning({
            stateDigest: vercelInstallationAuthorizationStates.stateDigest,
          });
        const memberships = await transaction
          .delete(hostedWorkspaceMemberships)
          .where(membershipPredicate(authority))
          .returning({ workspaceId: hostedWorkspaceMemberships.workspaceId });
        if (memberships.length !== 1) {
          throw new Error("Hosted membership deletion was not durable.");
        }
        return {
          membershipRowsDeleted: 1,
          operationRowsDeleted: operations.length,
          sessionRowsDeleted: sessions.length,
          integrationRowsDeleted:
            githubInstallations.length +
            githubBindings.length +
            vercelInstallations.length,
          authorizationStateRowsDeleted:
            githubStates.length + vercelStates.length,
        };
      });
    },
  };
}
