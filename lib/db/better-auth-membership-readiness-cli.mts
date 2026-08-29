import postgres from "postgres";

import { verifyBetterAuthMembershipReadBack } from "./better-auth-membership-readiness";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";
import { readPrivateDatabaseUrl } from "./private-database-url";

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--database-url-fd" ||
  process.argv[3] !== "0"
) {
  throw new Error(
    "hosted:membership-migration-verify requires its private database URL fd.",
  );
}

const databaseUrl = readPrivateDatabaseUrl(0);
const client = postgres(databaseUrl, hostedTaskPostgresOptions);
try {
  const readBack = await client.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    const mode = await transaction<{ transactionReadOnly: string }[]>`
      SELECT current_setting('transaction_read_only') AS "transactionReadOnly"
    `;
    const activeLegacyRows = await transaction<
      Array<{
        issuer: string;
        audience: string;
        workspaceId: string;
        userId: string;
      }>
    >`
      SELECT
        issuer,
        audience,
        workspace_id AS "workspaceId",
        owner_user_id AS "userId"
      FROM hosted_workspace_membership
      WHERE active = true
      ORDER BY issuer, audience, workspace_id, owner_user_id
    `;
    const migratedRows = await transaction<
      Array<{
        issuer: string;
        audience: string;
        workspaceId: string;
        userId: string;
        role: "owner";
      }>
    >`
      SELECT
        organization.issuer,
        organization.audience,
        organization.workspace_id AS "workspaceId",
        member.user_id AS "userId",
        member.role
      FROM organization
      JOIN member ON member.organization_id = organization.id
      WHERE EXISTS (
        SELECT 1 FROM hosted_workspace_membership
        WHERE active = true
          AND issuer = organization.issuer
          AND audience = organization.audience
          AND workspace_id = organization.workspace_id
      )
      ORDER BY issuer, audience, "workspaceId", "userId"
    `;
    const [counts] = await transaction<
      Array<{
        inactiveLegacyCount: number;
        pendingInvitationCount: number;
        nativeOrganizationCount: number;
        orphanedActiveSessionCount: number;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM hosted_workspace_membership
          WHERE active = false) AS "inactiveLegacyCount",
        (SELECT count(*)::int FROM invitation
          WHERE status = 'pending') AS "pendingInvitationCount",
        (SELECT count(*)::int FROM organization
          WHERE NOT EXISTS (
            SELECT 1 FROM hosted_workspace_membership
            WHERE active = true
              AND issuer = organization.issuer
              AND audience = organization.audience
              AND workspace_id = organization.workspace_id
          )) AS "nativeOrganizationCount",
        (SELECT count(*)::int FROM session AS auth_session
          WHERE auth_session.active_organization_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM member
              WHERE member.organization_id = auth_session.active_organization_id
                AND member.user_id = auth_session.user_id
            )) AS "orphanedActiveSessionCount"
    `;
    if (!counts) {
      throw new Error("Better Auth membership counts were not readable.");
    }
    return {
      transactionReadOnly: mode[0]?.transactionReadOnly === "on",
      activeLegacyRows,
      migratedRows,
      ...counts,
    };
  });
  const receipt = verifyBetterAuthMembershipReadBack({
    readBack,
    observedAt: new Date(),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await client.end({ timeout: 5 });
}
